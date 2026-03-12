import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStorage } from '../sqlite.js';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Memory } from '../../types.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: nanoid(),
    timestamp: Date.now(),
    project: 'test',
    scope: 'project',
    type: 'decision',
    content: 'test content',
    tags: [],
    embedding: new Array(768).fill(0.1),
    sessionId: 'sess1',
    isCore: false,
    recallCount: 0,
    lastRecalled: 0,
    ...overrides,
  };
}

describe('Graph edges', () => {
  let storage: SqliteStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `memento-test-graph-${nanoid(6)}.db`);
    storage = new SqliteStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it('should add bidirectional edges', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    storage.store(m1);
    storage.store(m2);
    storage.addEdge(m1.id, m2.id, 0.85);

    const neighbors = storage.getNeighbors(m1.id);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].id).toBe(m2.id);

    const reverseNeighbors = storage.getNeighbors(m2.id);
    expect(reverseNeighbors).toHaveLength(1);
    expect(reverseNeighbors[0].id).toBe(m1.id);
  });

  it('should calculate degree correctly', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    const m3 = makeMemory();
    storage.store(m1);
    storage.store(m2);
    storage.store(m3);
    storage.addEdge(m1.id, m2.id, 0.85);
    storage.addEdge(m1.id, m3.id, 0.75);

    expect(storage.getDegree(m1.id)).toBe(2);
    expect(storage.getDegree(m2.id)).toBe(1);
  });

  it('should transfer edges from old to new memory', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    const m3 = makeMemory();
    storage.store(m1);
    storage.store(m2);
    storage.store(m3);
    storage.addEdge(m1.id, m2.id, 0.85);
    storage.addEdge(m1.id, m3.id, 0.75);

    storage.transferEdges(m1.id, m2.id);

    expect(storage.getDegree(m1.id)).toBe(0);
    expect(storage.getDegree(m2.id)).toBe(1);
    expect(storage.getNeighbors(m2.id)[0].id).toBe(m3.id);
  });

  it('should delete memory and cascade edges', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    storage.store(m1);
    storage.store(m2);
    storage.addEdge(m1.id, m2.id, 0.85);
    storage.deleteMemory(m1.id);

    expect(storage.getById(m1.id)).toBeUndefined();
    expect(storage.getDegree(m2.id)).toBe(0);
  });

  it('should get neighbors with similarity scores', () => {
    const m1 = makeMemory();
    const m2 = makeMemory({ content: 'related content' });
    storage.store(m1);
    storage.store(m2);
    storage.addEdge(m1.id, m2.id, 0.82);

    const neighbors = storage.getNeighborsWithSimilarity(m1.id);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].memory.id).toBe(m2.id);
    expect(neighbors[0].similarity).toBeCloseTo(0.82);
  });

  it('should get degrees in batch', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    const m3 = makeMemory();
    storage.store(m1);
    storage.store(m2);
    storage.store(m3);
    storage.addEdge(m1.id, m2.id, 0.85);
    storage.addEdge(m1.id, m3.id, 0.75);

    const degrees = storage.getDegrees([m1.id, m2.id, m3.id]);
    expect(degrees.get(m1.id)).toBe(2);
    expect(degrees.get(m2.id)).toBe(1);
    expect(degrees.get(m3.id)).toBe(1);
  });
});
