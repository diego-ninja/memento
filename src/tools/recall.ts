import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HybridSearch } from '../search/hybrid.js';
import type { Reranker } from '../search/reranker.js';
import type { UnifiedStorage } from '../storage/unified.js';
import type { MementoConfig, RecallResult } from '../types.js';

const TYPE_CHAR: Record<string, string> = {
  decision: 'D', learning: 'L', preference: 'P', fact: 'F', context: 'C',
};

export function registerRecallTool(
  server: McpServer,
  search: HybridSearch,
  reranker: Reranker,
  storage: UnifiedStorage,
  config: MementoConfig,
): void {
  server.tool(
    'recall',
    'Search persistent memory. Returns compact results: TYPE|MMDD|content. Use expand with a memory ID to navigate the graph.',
    {
      query: z.string().describe('Natural language query'),
      expand: z.string().optional().describe('Memory ID (6-char prefix) to expand neighbors from graph'),
      type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']).optional(),
      limit: z.number().optional().describe('Max results (default: 3)'),
    },
    async ({ query, expand, type, limit }) => {
      // Graph expansion mode
      if (expand) {
        return handleExpand(expand, storage);
      }

      // Normal recall
      const results = await search.search({ query, type, limit: config.search.topK });

      // Get degrees for graph boost
      const ids = results.map(r => r.memory.id);
      const degrees = storage.getDegrees(ids);

      const ranked = reranker.rerank(results, (limit ?? config.search.finalK) * 3, degrees);
      const diversified = reranker.diversify(ranked, limit ?? config.search.finalK);

      if (diversified.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }

      // Fire-and-forget: increment recall counts + auto-promote
      for (const r of diversified) {
        try {
          storage.incrementRecallCount(r.memory.id);
          const newCount = r.memory.recallCount + 1;
          if (!r.memory.isCore && newCount >= config.core.promoteAfterRecalls) {
            storage.setCore(r.memory.id, true);
          }
          const degree = degrees.get(r.memory.id) ?? 0;
          if (!r.memory.isCore && degree >= 10) {
            storage.setCore(r.memory.id, true);
          }
        } catch {}
      }

      // Build related section from graph
      const related = buildRelatedSection(diversified, storage);

      let output = formatCompact(diversified);
      if (related) {
        output += '\n\n-- related --\n' + related;
      }

      return { content: [{ type: 'text', text: output }] };
    },
  );
}

function handleExpand(shortId: string, storage: UnifiedStorage) {
  const neighbors = storage.getNeighborsWithSimilarity(shortId);

  if (neighbors.length === 0) {
    return { content: [{ type: 'text' as const, text: `No neighbors for ${shortId}.` }] };
  }

  const lines = neighbors.map(n => {
    const t = TYPE_CHAR[n.memory.type] ?? '?';
    const d = new Date(n.memory.timestamp);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const sim = (n.similarity * 100).toFixed(0);
    return `${t}|${mm}${dd}|${n.memory.content} (${sim}%)`;
  });

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

function formatCompact(results: (RecallResult & { relatedCount?: number })[]): string {
  return results.map(r => {
    const t = TYPE_CHAR[r.memory.type] ?? '?';
    const d = new Date(r.memory.timestamp);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const shortId = r.memory.id.slice(0, 6);
    const related = (r as any).relatedCount > 0 ? ` (+${(r as any).relatedCount} related)` : '';
    return `[${shortId}] ${t}|${mm}${dd}|${r.memory.content}${related}`;
  }).join('\n');
}

function buildRelatedSection(
  results: RecallResult[],
  storage: UnifiedStorage,
): string {
  const shown = new Set(results.map(r => r.memory.id));
  const relatedLines: string[] = [];

  for (const r of results) {
    const neighbors = storage.getNeighbors(r.memory.id);
    for (const n of neighbors) {
      if (shown.has(n.id)) continue;
      shown.add(n.id);
      const degree = storage.getDegree(n.id);
      const shortId = n.id.slice(0, 6);
      const truncated = n.content.length > 60 ? n.content.slice(0, 60) + '...' : n.content;
      relatedLines.push(`[${shortId}] ${truncated} (${degree} connections)`);
    }
  }

  return relatedLines.slice(0, 5).join('\n');
}
