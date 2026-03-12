import { describe, it, expect } from 'vitest';
import { Reranker } from '../reranker.js';
import type { RecallResult } from '../../types.js';

function makeResult(id: string, score: number, embedding: number[]): RecallResult {
  return {
    memory: {
      id,
      timestamp: Date.now(),
      project: 'test',
      scope: 'project',
      type: 'decision',
      content: `content-${id}`,
      tags: [],
      embedding,
      sessionId: 'sess1',
      isCore: false,
      recallCount: 0,
      lastRecalled: 0,
    },
    score,
    source: 'rrf',
  };
}

function similarEmbedding(base: number[], noise: number = 0.01): number[] {
  return base.map(v => v + (Math.random() - 0.5) * noise);
}

describe('Reranker.diversify', () => {
  const reranker = new Reranker();

  it('should keep diverse results unchanged', () => {
    const e1 = Array(768).fill(0).map(() => Math.random());
    const e2 = Array(768).fill(0).map(() => Math.random());
    const e3 = Array(768).fill(0).map(() => Math.random());

    const results = [
      makeResult('a', 1.0, e1),
      makeResult('b', 0.9, e2),
      makeResult('c', 0.8, e3),
    ];

    const diversified = reranker.diversify(results, 3);
    expect(diversified).toHaveLength(3);
  });

  it('should remove near-duplicate results', () => {
    const e1 = Array(768).fill(0).map(() => Math.random());
    const e1clone = similarEmbedding(e1, 0.001);

    const results = [
      makeResult('a', 1.0, e1),
      makeResult('a-dup', 0.95, e1clone),
      makeResult('b', 0.9, Array(768).fill(0).map(() => Math.random())),
    ];

    const diversified = reranker.diversify(results, 3);
    expect(diversified).toHaveLength(2);
    expect(diversified.map(r => r.memory.id)).not.toContain('a-dup');
  });

  it('should track relatedCount for skipped duplicates', () => {
    const e1 = Array(768).fill(0).map(() => Math.random());
    const e1c1 = similarEmbedding(e1, 0.001);
    const e1c2 = similarEmbedding(e1, 0.001);

    const results = [
      makeResult('a', 1.0, e1),
      makeResult('a-dup1', 0.95, e1c1),
      makeResult('a-dup2', 0.9, e1c2),
      makeResult('b', 0.85, Array(768).fill(0).map(() => Math.random())),
    ];

    const diversified = reranker.diversify(results, 3);
    const aResult = diversified.find(r => r.memory.id === 'a') as any;
    expect(aResult.relatedCount).toBe(2);
  });

  it('should respect threshold parameter', () => {
    const e1 = Array(768).fill(0).map(() => Math.random());
    const e1mild = similarEmbedding(e1, 1.0);

    const results = [
      makeResult('a', 1.0, e1),
      makeResult('b', 0.9, e1mild),
    ];

    const strict = reranker.diversify(results, 3, 0.99);
    expect(strict).toHaveLength(2);
  });
});
