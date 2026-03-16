import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnifiedStorage } from '../unified.js';
import type { Memory } from '../../types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let storage: UnifiedStorage;
let dbPath: string;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    project: 'test',
    scope: 'project',
    type: 'decision',
    content: 'test memory content',
    tags: [],
    embedding: new Array(768).fill(0.1),
    sessionId: 'test-session',
    isCore: false,
    recallCount: 0,
    lastRecalled: 0,
    ...overrides,
  };
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `memento-unified-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  storage = new UnifiedStorage(dbPath);
});

afterEach(() => {
  storage.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

describe('UnifiedStorage', () => {
  describe('store and retrieve', () => {
    it('stores and retrieves a memory by id', () => {
      const mem = makeMemory({ id: 'test-1' });
      storage.store(mem);

      const retrieved = storage.getById('test-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.content).toBe('test memory content');
      expect(retrieved!.type).toBe('decision');
    });

    it('counts memories', () => {
      expect(storage.count()).toBe(0);
      storage.store(makeMemory());
      storage.store(makeMemory());
      expect(storage.count()).toBe(2);
    });

    it('gets all memories', () => {
      storage.store(makeMemory({ id: 'a' }));
      storage.store(makeMemory({ id: 'b' }));
      expect(storage.getAll()).toHaveLength(2);
    });
  });

  describe('text search', () => {
    it('finds memories by text content', () => {
      storage.store(makeMemory({ id: 'a', content: 'Redis is great for search' }));
      storage.store(makeMemory({ id: 'b', content: 'SQLite is great for persistence' }));
      storage.store(makeMemory({ id: 'c', content: 'PostgreSQL is also a database' }));

      const results = storage.searchText('Redis');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('Redis');
    });
  });

  describe('vector search', () => {
    it('finds similar memories by embedding', () => {
      const emb1 = new Array(768).fill(0.5);
      const emb2 = new Array(768).fill(0.1);
      storage.store(makeMemory({ id: 'similar', embedding: emb1, content: 'similar one' }));
      storage.store(makeMemory({ id: 'different', embedding: emb2, content: 'different one' }));

      const results = storage.searchVector(emb1, 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe('similar');
    });
  });

  describe('core memories', () => {
    it('manages core status', () => {
      storage.store(makeMemory({ id: 'core-1', isCore: true, content: 'core memory' }));
      storage.store(makeMemory({ id: 'not-core', content: 'regular memory' }));

      const core = storage.getCoreMemories();
      expect(core).toHaveLength(1);
      expect(core[0].id).toBe('core-1');

      storage.setCore('not-core', true);
      expect(storage.getCoreMemories()).toHaveLength(2);

      storage.setCore('core-1', false);
      expect(storage.getCoreMemories()).toHaveLength(1);
    });

    it('increments recall count', () => {
      storage.store(makeMemory({ id: 'test-recall' }));
      storage.incrementRecallCount('test-recall');
      storage.incrementRecallCount('test-recall');

      const mem = storage.getById('test-recall');
      expect(mem!.recallCount).toBe(2);
      expect(mem!.lastRecalled).toBeGreaterThan(0);
    });
  });

  describe('graph', () => {
    it('creates and queries edges', () => {
      storage.store(makeMemory({ id: 'a', content: 'memory A' }));
      storage.store(makeMemory({ id: 'b', content: 'memory B' }));
      storage.store(makeMemory({ id: 'c', content: 'memory C' }));

      storage.addEdge('a', 'b', 0.85);
      storage.addEdge('a', 'c', 0.75);

      const neighbors = storage.getNeighbors('a');
      expect(neighbors).toHaveLength(2);

      const degrees = storage.getDegrees(['a', 'b', 'c']);
      expect(degrees.get('a')).toBe(2);
      expect(degrees.get('b')).toBe(1); // bidirectional
    });

    it('transfers edges on merge', () => {
      storage.store(makeMemory({ id: 'old' }));
      storage.store(makeMemory({ id: 'new' }));
      storage.store(makeMemory({ id: 'related' }));

      storage.addEdge('old', 'related', 0.8);
      storage.transferEdges('old', 'new');

      expect(storage.getNeighbors('new')).toHaveLength(1);
      expect(storage.getNeighbors('old')).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('deletes memory and its edges', () => {
      storage.store(makeMemory({ id: 'target' }));
      storage.store(makeMemory({ id: 'neighbor' }));
      storage.addEdge('target', 'neighbor', 0.8);

      storage.deleteMemory('target');

      expect(storage.getById('target')).toBeUndefined();
      expect(storage.getNeighbors('neighbor')).toHaveLength(0);
    });
  });

  describe('merge content', () => {
    it('updates content and embedding', () => {
      storage.store(makeMemory({ id: 'merge-test', content: 'old content' }));

      const newEmb = new Array(768).fill(0.9);
      storage.mergeContent('merge-test', 'merged content', newEmb);

      const updated = storage.getById('merge-test');
      expect(updated!.content).toBe('merged content');
    });
  });
});
