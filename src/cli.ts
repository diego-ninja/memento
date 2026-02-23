#!/usr/bin/env node

import { loadConfig, ensureDataDirs, getProjectDbPath } from './config.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';

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
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: memento <recall|stats|flush> [args]');
      process.exit(1);
  }
}

async function handleRecall(config: any, projectPath: string, query: string) {
  if (!query) {
    console.error('Usage: memento recall <query>');
    process.exit(1);
  }

  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const embeddings = new OllamaEmbeddings(config.ollama);
  const search = new HybridSearch(storage, embeddings);
  const reranker = new Reranker();

  const results = await search.search({ query, limit: config.search.topK });
  const ranked = reranker.rerank(results, config.search.finalK);

  if (ranked.length === 0) {
    console.log('No relevant memories found.');
  } else {
    for (const r of ranked) {
      const date = new Date(r.memory.timestamp).toISOString().split('T')[0];
      console.log(`[${r.memory.type}] (${date}) ${r.memory.content}`);
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

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
