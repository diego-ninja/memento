#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ensureDataDirs, getProjectDbPath } from './config.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';
import { registerRecallTool } from './tools/recall.js';
import { registerRememberTool } from './tools/remember.js';
import { registerRememberExtractTool } from './tools/remember-extract.js';

async function main() {
  const config = loadConfig();
  const projectPath = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  ensureDataDirs(projectPath);

  const projectStorage = new SyncStorage(
    config.redis,
    getProjectDbPath(projectPath),
    'memento',
  );
  await projectStorage.connect();
  await projectStorage.hydrate();

  const embeddings = new OllamaEmbeddings(config.ollama);
  const search = new HybridSearch(projectStorage, embeddings);
  const reranker = new Reranker();

  const server = new McpServer({
    name: 'memento',
    version: '0.1.0',
  });

  registerRecallTool(server, search, reranker, config);
  registerRememberTool(server, projectStorage, embeddings, config, projectPath);
  registerRememberExtractTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
