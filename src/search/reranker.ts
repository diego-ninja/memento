import type { RecallResult, MemoryType } from '../types.js';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

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
      const recallBoost = 1 + Math.sqrt(r.memory.recallCount) * 0.05;
      const finalScore = r.score * typeWeight * (0.5 + 0.5 * recencyBoost) * recallBoost;
      return { ...r, score: finalScore };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, finalK);
  }

  diversify(
    results: RecallResult[],
    finalK: number,
    threshold: number = 0.85,
  ): (RecallResult & { relatedCount?: number })[] {
    const selected: RecallResult[] = [];
    const relatedCounts = new Map<string, number>();

    for (const r of results) {
      if (selected.length >= finalK) break;

      if (r.memory.embedding.length === 0) {
        selected.push(r);
        continue;
      }

      let tooSimilarTo: RecallResult | undefined;
      for (const s of selected) {
        if (s.memory.embedding.length === 0) continue;
        if (cosineSimilarity(r.memory.embedding, s.memory.embedding) > threshold) {
          tooSimilarTo = s;
          break;
        }
      }

      if (tooSimilarTo) {
        relatedCounts.set(
          tooSimilarTo.memory.id,
          (relatedCounts.get(tooSimilarTo.memory.id) ?? 0) + 1,
        );
        continue;
      }

      selected.push(r);
    }

    return selected.map(r => ({
      ...r,
      relatedCount: relatedCounts.get(r.memory.id) ?? 0,
    }));
  }
}
