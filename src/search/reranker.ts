import type { RecallResult, MemoryType } from '../types.js';

const TYPE_WEIGHTS: Record<MemoryType, number> = {
  decision: 1.3,
  learning: 1.2,
  preference: 1.15,
  fact: 1.0,
  context: 0.9,
};

const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export class Reranker {
  rerank(results: RecallResult[], finalK: number): RecallResult[] {
    const supersededIds = new Set(
      results.map(r => r.memory.supersedes).filter(Boolean) as string[],
    );
    const filtered = results.filter(r => !supersededIds.has(r.memory.id));

    const now = Date.now();
    const scored = filtered.map(r => {
      const typeWeight = TYPE_WEIGHTS[r.memory.type] ?? 1.0;
      const age = now - r.memory.timestamp;
      const recencyBoost = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
      const finalScore = r.score * typeWeight * (0.5 + 0.5 * recencyBoost);
      return { ...r, score: finalScore };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, finalK);
  }
}
