import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HybridSearch } from '../search/hybrid.js';
import type { Reranker } from '../search/reranker.js';
import type { MementoConfig, RecallResult } from '../types.js';

export function registerRecallTool(
  server: McpServer,
  search: HybridSearch,
  reranker: Reranker,
  config: MementoConfig,
): void {
  server.tool(
    'recall',
    'Search persistent memory for relevant decisions, learnings, preferences, and context. Use this when you need historical context about the project, user preferences, or past decisions.',
    {
      query: z.string().describe('Natural language query describing what you need to remember'),
      type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']).optional()
        .describe('Filter by memory type'),
      limit: z.number().optional().describe('Max results to return (default: 5)'),
    },
    async ({ query, type, limit }) => {
      const results = await search.search({
        query,
        type,
        limit: config.search.topK,
      });

      const ranked = reranker.rerank(results, limit ?? config.search.finalK);

      if (ranked.length === 0) {
        return {
          content: [{ type: 'text', text: 'No relevant memories found.' }],
        };
      }

      const formatted = formatResults(ranked);
      return {
        content: [{ type: 'text', text: formatted }],
      };
    },
  );
}

function formatResults(results: RecallResult[]): string {
  return results.map((r, i) => {
    const date = new Date(r.memory.timestamp).toISOString().split('T')[0];
    const tags = r.memory.tags.length > 0 ? ` [${r.memory.tags.join(', ')}]` : '';
    return `${i + 1}. [${r.memory.type}] (${date})${tags}\n   ${r.memory.content}`;
  }).join('\n\n');
}
