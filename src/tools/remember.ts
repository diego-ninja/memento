import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { MementoConfig, Memory } from '../types.js';
import { getProjectId } from '../config.js';

export function registerRememberTool(
  server: McpServer,
  storage: SyncStorage,
  embeddings: OllamaEmbeddings,
  config: MementoConfig,
  projectPath: string,
): void {
  server.tool(
    'remember',
    'Store one or more memories for future recall. Use this to persist decisions, learnings, preferences, or facts.',
    {
      memories: z.array(z.object({
        type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']),
        content: z.string().describe('Concise description (1-3 sentences)'),
        tags: z.array(z.string()).describe('Relevant keywords for search'),
        scope: z.enum(['global', 'project']).optional().describe('global = shared across projects, project = this project only'),
      })).describe('Memories to store'),
    },
    async ({ memories }) => {
      const sessionId = process.env.CLAUDE_SESSION_ID ?? nanoid(8);
      const projectId = getProjectId(projectPath);
      let stored = 0;
      let deduplicated = 0;

      for (const input of memories) {
        const embedding = await embeddings.generate(input.content);

        const existing = await storage.search.vector(embedding, 1);
        if (existing.length > 0) {
          const similarity = cosineSimilarity(
            embedding,
            existing[0].embedding.length > 0 ? existing[0].embedding : await embeddings.generate(existing[0].content),
          );

          if (similarity > config.search.deduplicationThreshold) {
            deduplicated++;
            continue;
          }

          const memory: Memory = {
            id: nanoid(),
            timestamp: Date.now(),
            project: projectId,
            scope: input.scope ?? 'project',
            type: input.type,
            content: input.content,
            tags: input.tags,
            embedding,
            sessionId,
            supersedes: similarity > config.search.supersededThreshold
              ? existing[0].id
              : undefined,
          };

          await storage.store(memory);
          stored++;
          continue;
        }

        const memory: Memory = {
          id: nanoid(),
          timestamp: Date.now(),
          project: projectId,
          scope: input.scope ?? 'project',
          type: input.type,
          content: input.content,
          tags: input.tags,
          embedding,
          sessionId,
        };

        await storage.store(memory);
        stored++;
      }

      return {
        content: [{
          type: 'text',
          text: `Stored ${stored} memories.${deduplicated > 0 ? ` Skipped ${deduplicated} duplicates.` : ''}`,
        }],
      };
    },
  );
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
