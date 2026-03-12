import { z } from 'zod';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { MementoConfig } from '../types.js';
import { getProjectId } from '../config.js';
import { storeWithDedup } from '../storage/pipeline.js';

export function registerRememberTool(
  server: McpServer,
  storage: SyncStorage,
  embeddings: OllamaEmbeddings,
  config: MementoConfig,
  projectPath: string,
  mergeWithLLM?: (old: string, new_: string) => Promise<string>,
): void {
  server.tool(
    'remember',
    'Persist memories as telegraphic notes. Content should be dense, no articles/filler: "module: key=value, fact>detail"',
    {
      memories: z.array(z.object({
        type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']),
        content: z.string().describe('Telegraphic note: dense, no filler words'),
        core: z.boolean().optional().describe('true = always loaded at session start'),
      })).describe('Memories to store'),
    },
    async ({ memories: inputs }) => {
      const sessionId = process.env.CLAUDE_SESSION_ID ?? nanoid(8);
      const projectId = getProjectId(projectPath);

      const result = await storeWithDedup(inputs, {
        storage,
        sqlite: storage.sqliteDb,
        embeddings,
        config,
        projectId,
        sessionId,
        mergeWithLLM,
      });

      if (result.stored > 0 || result.merged > 0) {
        updateStatsCache(storage);
      }

      const parts = [`Stored ${result.stored}`];
      if (result.merged > 0) parts.push(`merged ${result.merged}`);
      if (result.deduplicated > 0) parts.push(`skipped ${result.deduplicated} dupes`);

      return {
        content: [{ type: 'text', text: parts.join(', ') + '.' }],
      };
    },
  );
}

const STATS_PATH = `${process.env.HOME}/.memento-stats`;

function updateStatsCache(storage: SyncStorage): void {
  storage.search.count().then(total => {
    let recalled = 0;
    try {
      const prev = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
      recalled = prev.recalled ?? 0;
    } catch { /* no previous stats */ }
    fs.writeFileSync(STATS_PATH, JSON.stringify({
      total, recalled, updated: Math.floor(Date.now() / 1000),
    }));
  }).catch(() => {});
}
