#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ensureDataDirs, getProjectDbPath } from './config.js';
import { checkDependencies } from './health.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';
import { registerRecallTool } from './tools/recall.js';
import { registerRememberTool } from './tools/remember.js';

async function main() {
  const config = loadConfig();

  // Fail fast if dependencies are unavailable
  await checkDependencies(config);

  const projectPath = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  ensureDataDirs(projectPath);

  const projectStorage = new SyncStorage(
    config.redis,
    getProjectDbPath(projectPath),
    'memento',
  );
  await projectStorage.connect();

  // Lazy hydrate: only if Redis is empty
  const needsHydrate = await projectStorage.needsHydrate();
  if (needsHydrate) {
    projectStorage.hydrate().catch(console.error);
  }

  const embeddings = new OllamaEmbeddings({
    host: config.ollama.host,
    model: config.ollama.embeddingModel,
  });
  const search = new HybridSearch(projectStorage, embeddings, config.search.rrfK);
  const reranker = new Reranker();

  const mergeWithLLM = async (old: string, new_: string) => {
    return embeddings.merge(old, new_, config.ollama.generativeModel);
  };

  const server = new McpServer({
    name: 'memento',
    version: '0.3.0',
  });

  registerRecallTool(server, search, reranker, projectStorage, config);
  registerRememberTool(server, projectStorage, embeddings, config, projectPath, mergeWithLLM);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
