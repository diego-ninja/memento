#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ensureDataDirs, getProjectDbPath, getTranscriptDbPath } from './config.js';
import { checkDependencies } from './health.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';
import { registerRecallTool } from './tools/recall.js';
import { registerRememberTool } from './tools/remember.js';
import { TranscriptDb } from './transcript/db.js';
import { registerTranscriptGrepTool } from './tools/transcript-grep.js';
import { registerTranscriptExpandTool } from './tools/transcript-expand.js';
import { registerTranscriptDescribeTool } from './tools/transcript-describe.js';
import { registerLlmMapTool } from './tools/llm-map.js';

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

  // Transcript layer
  const transcriptDb = new TranscriptDb(getTranscriptDbPath(projectPath));

  const server = new McpServer({
    name: 'memento',
    version: '1.0.0',
  });

  // Knowledge layer tools
  registerRecallTool(server, search, reranker, projectStorage, config);
  registerRememberTool(server, projectStorage, embeddings, config, projectPath, mergeWithLLM);

  // Transcript layer tools
  registerTranscriptGrepTool(server, transcriptDb);
  registerTranscriptExpandTool(server, transcriptDb);
  registerTranscriptDescribeTool(server, transcriptDb);

  // Operator tools
  registerLlmMapTool(server, config.ollama.host, config.ollama.generativeModel);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
