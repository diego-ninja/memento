#!/usr/bin/env node

import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { loadConfig, ensureDataDirs, getProjectDbPath, getProjectId } from './config.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';
import { extractFromTranscript, extractWithRegex } from './extract.js';

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
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: memento <recall|stats|flush|hydrate|core|extract|maintain> [args]');
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

  for (const mem of extracted) {
    const embedding = await embeddings.generate(mem.content);
    await storage.store({
      id: nanoid(),
      timestamp: Date.now(),
      project: projectId,
      scope: 'project',
      type: mem.type,
      content: mem.content,
      tags: [],
      embedding,
      sessionId,
      isCore: false,
      recallCount: 0,
      lastRecalled: 0,
    });
  }

  console.log(`Stored ${extracted.length} memories.`);
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

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
