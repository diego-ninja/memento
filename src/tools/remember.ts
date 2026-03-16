import { z } from 'zod';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { UnifiedStorage } from '../storage/unified.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { MementoConfig } from '../types.js';
import { getProjectId } from '../config.js';
import { storeWithDedup } from '../storage/pipeline.js';

export function registerRememberTool(
  server: McpServer,
  storage: UnifiedStorage,
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
        embeddings,
        config,
        projectId,
        sessionId,
        mergeWithLLM,
      });

      const parts = [`Stored ${result.stored}`];
      if (result.merged > 0) parts.push(`merged ${result.merged}`);
      if (result.deduplicated > 0) parts.push(`skipped ${result.deduplicated} dupes`);

      return {
        content: [{ type: 'text', text: parts.join(', ') + '.' }],
      };
    },
  );
}
