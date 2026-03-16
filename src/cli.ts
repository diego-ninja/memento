#!/usr/bin/env node

import fs from 'node:fs';
import { loadConfig, ensureDataDirs, getProjectDbPath, getProjectId, getTranscriptDbPath } from './config.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';
import { extractFromTranscript, extractWithRegex } from './extract.js';
import { TranscriptDb } from './transcript/db.js';
import { ingestMessage, ingestTranscriptFile } from './transcript/ingest.js';
import { buildSummaryDAG, checkpoint } from './transcript/summarize.js';
import { detectArtifacts, storeDetectedArtifacts, generateExplorationSummary } from './transcript/artifacts.js';
import { detectSessionEdges, storeSessionEdges } from './transcript/session-edges.js';

const [,, command, ...args] = process.argv;

async function main() {
  const config = loadConfig();
  const projectPath = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  ensureDataDirs(projectPath);

  switch (command) {
    case 'recall':
      await handleRecall(config, projectPath, args.join(' '));
      break;
    case 'stats':
      await handleStats(config, projectPath);
      break;
    case 'flush':
      await handleFlush(config, projectPath);
      break;
    case 'hydrate':
      await handleHydrate(config, projectPath);
      break;
    case 'core':
      await handleCore(config, projectPath);
      break;
    case 'extract':
      await handleExtract(config, projectPath, args[0]);
      break;
    case 'maintain':
      await handleMaintain(config, projectPath);
      break;
    case 'ingest-message':
      handleIngestMessage(projectPath, args);
      break;
    case 'ingest-transcript':
      handleIngestTranscript(projectPath, args);
      break;
    case 'sessions':
      handleSessions(projectPath, args);
      break;
    case 'build-dag':
      await handleBuildDag(config, projectPath, args);
      break;
    case 'checkpoint':
      await handleCheckpoint(config, projectPath, args);
      break;
    case 'session-summary':
      handleSessionSummary(projectPath, args);
      break;
    case 'store-compact-summary':
      handleStoreCompactSummary(projectPath, args);
      break;
    case 'detect-artifacts':
      handleDetectArtifacts(projectPath, args);
      break;
    case 'link-sessions':
      handleLinkSessions(projectPath);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: memento <recall|stats|flush|hydrate|core|extract|maintain|ingest-message|ingest-transcript|sessions> [args]');
      process.exit(1);
  }
}

const TYPE_CHAR: Record<string, string> = {
  decision: 'D', learning: 'L', preference: 'P', fact: 'F', context: 'C',
};

function formatCompact(memory: { type: string; timestamp: number; content: string }): string {
  const t = TYPE_CHAR[memory.type] ?? '?';
  const d = new Date(memory.timestamp);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${t}|${mm}${dd}|${memory.content}`;
}

async function handleRecall(config: any, projectPath: string, query: string) {
  if (!query) {
    console.error('Usage: memento recall <query>');
    process.exit(1);
  }

  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const embeddings = new OllamaEmbeddings({ host: config.ollama.host, model: config.ollama.embeddingModel });
  const search = new HybridSearch(storage, embeddings, config.search.rrfK);
  const reranker = new Reranker();

  const results = await search.search({ query, limit: config.search.topK });
  const ranked = reranker.rerank(results, config.search.finalK);

  if (ranked.length === 0) {
    console.log('No relevant memories found.');
  } else {
    for (const r of ranked) {
      console.log(formatCompact(r.memory));
    }
  }

  await storage.disconnect();
}

async function handleStats(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const count = await storage.search.count();
  console.log(JSON.stringify({ memories: count, project: projectPath }));

  await storage.disconnect();
}

async function handleFlush(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();
  await storage.flush();
  console.log('All memories flushed.');
  await storage.disconnect();
}

async function handleHydrate(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const needed = await storage.needsHydrate();
  if (!needed) {
    console.log('Redis already has data. Skipping hydrate.');
    await storage.disconnect();
    return;
  }

  console.log('Hydrating Redis from SQLite...');
  await storage.hydrate();
  const count = await storage.search.count();
  console.log(`Hydrated ${count} memories.`);

  await storage.disconnect();
}

async function handleCore(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const core = storage.getCoreMemories();
  if (core.length === 0) {
    console.log('No core memories.');
  } else {
    for (const m of core) {
      console.log(formatCompact(m));
    }
  }

  await storage.disconnect();
}

async function handleExtract(config: any, projectPath: string, transcriptPath: string) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    console.error('Usage: memento extract <transcript-path>');
    process.exit(1);
  }

  const transcript = fs.readFileSync(transcriptPath, 'utf-8');
  let extracted;

  try {
    extracted = await extractFromTranscript(
      transcript,
      config.ollama.host,
      config.extraction?.ollama?.model ?? config.ollama.generativeModel,
    );
    console.log(`Extracted ${extracted.length} memories via LLM.`);
  } catch {
    console.log('LLM extraction failed, falling back to regex.');
    extracted = extractWithRegex(transcript);
    console.log(`Extracted ${extracted.length} memories via regex.`);
  }

  if (extracted.length === 0) {
    console.log('No memories extracted.');
    return;
  }

  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const embeddings = new OllamaEmbeddings({ host: config.ollama.host, model: config.ollama.embeddingModel });
  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'extract';
  const projectId = getProjectId(projectPath);

  const { storeWithDedup } = await import('./storage/pipeline.js');
  const result = await storeWithDedup(extracted, {
    storage,
    sqlite: storage.sqliteDb,
    embeddings,
    config,
    projectId,
    sessionId,
  });

  console.log(`Stored ${result.stored}, merged ${result.merged}, skipped ${result.deduplicated} dupes.`);
  await storage.disconnect();
}

async function handleMaintain(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const core = storage.getCoreMemories();
  const now = Date.now();
  const maxStaleMs = (config.core.degradeAfterSessions ?? 30) * 24 * 60 * 60 * 1000;
  let degraded = 0;

  for (const m of core) {
    const lastActive = Math.max(m.lastRecalled, m.timestamp);
    const staleness = now - lastActive;
    if (staleness > maxStaleMs) {
      await storage.setCore(m.id, false);
      degraded++;
    }
  }

  if (degraded > 0) {
    console.log(`Degraded ${degraded} memories from core.`);
  }

  await storage.disconnect();
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}

function handleIngestMessage(projectPath: string, args: string[]): void {
  const opts = parseArgs(args);
  const sessionId = opts.session;
  const role = opts.role;
  const content = opts.content;

  if (!sessionId || !role || !content) {
    console.error('Usage: memento ingest-message --session <id> --role <role> --content <text>');
    process.exit(1);
  }

  const projectId = getProjectId(projectPath);
  const db = new TranscriptDb(getTranscriptDbPath(projectPath));
  ingestMessage(db, sessionId, projectId, role as any, content);
  db.close();
}

function handleIngestTranscript(projectPath: string, args: string[]): void {
  const opts = parseArgs(args);
  const sessionId = opts.session;
  const transcriptPath = opts.path ?? args[0];

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    console.error('Usage: memento ingest-transcript --session <id> --path <transcript.jsonl>');
    process.exit(1);
  }

  const projectId = getProjectId(projectPath);
  const db = new TranscriptDb(getTranscriptDbPath(projectPath));
  const result = ingestTranscriptFile(
    db,
    transcriptPath,
    sessionId ?? `session-${Date.now()}`,
    projectId,
  );
  console.log(`Ingested ${result.messages} messages (${result.tokens} tokens).`);
  db.close();
}

async function handleBuildDag(config: any, projectPath: string, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const sessionId = opts.session;

  if (!sessionId) {
    console.error('Usage: memento build-dag --session <id>');
    process.exit(1);
  }

  const db = new TranscriptDb(getTranscriptDbPath(projectPath));
  const result = await buildSummaryDAG(sessionId, db, {
    ollamaHost: config.ollama.host,
    generativeModel: config.ollama.generativeModel,
  });

  console.log(`DAG built: ${result.leafCount} leaves, ${result.totalNodes} total nodes, root=${result.rootId?.slice(0, 8) ?? 'none'}`);
  db.close();
}

async function handleCheckpoint(config: any, projectPath: string, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const sessionId = opts.session;

  if (!sessionId) {
    console.error('Usage: memento checkpoint --session <id>');
    process.exit(1);
  }

  const db = new TranscriptDb(getTranscriptDbPath(projectPath));
  const result = await checkpoint(sessionId, db, {
    ollamaHost: config.ollama.host,
    generativeModel: config.ollama.generativeModel,
  });
  console.log(result);
  db.close();
}

function handleSessionSummary(projectPath: string, args: string[]): void {
  const opts = parseArgs(args);
  const sessionId = opts.session;

  if (!sessionId) {
    console.error('Usage: memento session-summary --session <id>');
    process.exit(1);
  }

  const db = new TranscriptDb(getTranscriptDbPath(projectPath));
  const summary = db.getRootSummary(sessionId);

  if (summary) {
    console.log(summary);
  } else {
    console.log('No summary available.');
  }
  db.close();
}

function handleStoreCompactSummary(projectPath: string, args: string[]): void {
  const opts = parseArgs(args);
  const sessionId = opts.session;
  const summary = opts.summary;

  if (!sessionId || !summary) {
    console.error('Usage: memento store-compact-summary --session <id> --summary <text>');
    process.exit(1);
  }

  const projectId = getProjectId(projectPath);
  const db = new TranscriptDb(getTranscriptDbPath(projectPath));
  db.ensureSession(sessionId, projectId);

  db.insertSummary({
    id: `cc-${Date.now()}`,
    sessionId,
    kind: 'compact_capture',
    content: summary,
    tokenCount: Math.ceil(summary.length / 4),
    level: -1,
  });

  db.close();
}

function handleDetectArtifacts(projectPath: string, args: string[]): void {
  const opts = parseArgs(args);
  const sessionId = opts.session;

  if (!sessionId) {
    console.error('Usage: memento detect-artifacts --session <id>');
    process.exit(1);
  }

  const db = new TranscriptDb(getTranscriptDbPath(projectPath));
  const messages = db.getMessagesBySession(sessionId);
  const detected = detectArtifacts(messages);

  if (detected.length === 0) {
    console.log('No artifacts detected.');
    db.close();
    return;
  }

  const stored = storeDetectedArtifacts(db, sessionId, detected);

  // Generate exploration summaries synchronously (deterministic, no LLM)
  for (const a of detected) {
    const artifact = db.getArtifactByPath(a.filePath);
    if (artifact && !artifact.explorationSummary) {
      const summary = generateExplorationSummary(a);
      db.setArtifactSummary(artifact.id, summary);
    }
  }

  console.log(`Detected ${stored} artifacts.`);
  db.close();
}

function handleLinkSessions(projectPath: string): void {
  const projectId = getProjectId(projectPath);
  const db = new TranscriptDb(getTranscriptDbPath(projectPath));

  const edges = detectSessionEdges(db, projectId);
  if (edges.length === 0) {
    console.log('No session edges to create.');
    db.close();
    return;
  }

  const stored = storeSessionEdges(db, edges);
  console.log(`Linked ${stored} session pairs.`);
  db.close();
}

function handleSessions(projectPath: string, args: string[]): void {
  const opts = parseArgs(args);
  const recent = parseInt(opts.recent ?? '3', 10);

  const projectId = getProjectId(projectPath);
  const db = new TranscriptDb(getTranscriptDbPath(projectPath));
  const sessions = db.getRecentSessions(projectId, recent);

  if (sessions.length === 0) {
    console.log('No recent sessions.');
    db.close();
    return;
  }

  for (const s of sessions) {
    const date = new Date(s.startedAt).toISOString().slice(0, 10);
    const summary = db.getRootSummary(s.id);
    if (summary) {
      console.log(`[${date}] ${summary}`);
    } else {
      console.log(`[${date}] ${s.totalMessages} messages, ${s.totalTokens} tokens`);
    }
  }

  db.close();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
