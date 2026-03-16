import { describe, it, expect } from 'vitest';
import { rrfFuse } from '../hybrid.js';
import type { Memory } from '../../types.js';

function mem(id: string): Memory {
  return {
    id, timestamp: Date.now(), project: 'test', scope: 'project',
    type: 'fact', content: `Memory ${id}`, tags: [], embedding: [],
    sessionId: 'test', isCore: false, recallCount: 0, lastRecalled: 0,
  };
}

describe('rrfFuse', () => {
  it('boosts memories appearing in both lists', () => {
    const textResults = [mem('a'), mem('b'), mem('c')];
    const vectorResults = [mem('b'), mem('d'), mem('a')];

    const fused = rrfFuse(textResults, vectorResults, 60);

    // Both 'a' and 'b' appear in both — they should be top 2
    const ids = fused.map(r => r.memory.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
  });

  it('includes memories from only one list', () => {
    const textResults = [mem('a')];
    const vectorResults = [mem('b')];

    const fused = rrfFuse(textResults, vectorResults, 60);
    expect(fused).toHaveLength(2);
  });

  it('returns empty for empty inputs', () => {
    const fused = rrfFuse([], [], 60);
    expect(fused).toHaveLength(0);
  });

  it('deduplicates by id', () => {
    const textResults = [mem('a'), mem('a')];
    const vectorResults = [mem('a')];

    const fused = rrfFuse(textResults, vectorResults, 60);
    expect(fused).toHaveLength(1);
  });
});
