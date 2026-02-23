import { describe, it, expect } from 'vitest';
import { Reranker } from '../reranker.js';
import type { RecallResult } from '../../types.js';

describe('Reranker', () => {
  const reranker = new Reranker();

  it('boosts recent memories over old ones', () => {
    const now = Date.now();
    const results: RecallResult[] = [
      makeResult('old', 0.9, now - 86400000 * 30),
      makeResult('new', 0.85, now - 3600000),
    ];

    const ranked = reranker.rerank(results, 5);
    expect(ranked[0].memory.id).toBe('new');
  });

  it('boosts decisions over context', () => {
    const now = Date.now();
    const results: RecallResult[] = [
      makeResult('ctx', 0.9, now, 'context'),
      makeResult('dec', 0.85, now, 'decision'),
    ];

    const ranked = reranker.rerank(results, 5);
    expect(ranked[0].memory.id).toBe('dec');
  });

  it('filters superseded memories when newer version exists', () => {
    const now = Date.now();
    const results: RecallResult[] = [
      { ...makeResult('old-dec', 0.9, now - 86400000), memory: { ...makeResult('old-dec', 0.9, now - 86400000).memory } },
      { ...makeResult('new-dec', 0.9, now), memory: { ...makeResult('new-dec', 0.9, now).memory, supersedes: 'old-dec' } },
    ];

    const ranked = reranker.rerank(results, 5);
    expect(ranked.find(r => r.memory.id === 'old-dec')).toBeUndefined();
  });

  it('limits output to finalK', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult(`m-${i}`, 0.5 + Math.random() * 0.5, Date.now()),
    );

    const ranked = reranker.rerank(results, 5);
    expect(ranked).toHaveLength(5);
  });
});

function makeResult(id: string, score: number, timestamp: number, type: string = 'fact'): RecallResult {
  return {
    memory: {
      id, timestamp, project: 'test', scope: 'project',
      type: type as any, content: `Memory ${id}`,
      tags: [], embedding: [], sessionId: 'test',
    },
    score, source: 'hybrid',
  };
}
