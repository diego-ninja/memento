import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { SqliteStorage } from '../sqlite.js';
import type { Memory } from '../../types.js';

const TEST_DB = '/tmp/memento-test.db';

describe('SqliteStorage', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    storage = new SqliteStorage(TEST_DB);
  });

  afterEach(() => {
    storage.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('stores and retrieves a memory', () => {
    const memory: Memory = {
      id: 'test-1',
      timestamp: Date.now(),
      project: 'memento',
      scope: 'project',
      type: 'decision',
      content: 'We chose Redis for search',
      tags: ['redis', 'architecture'],
      embedding: [0.1, 0.2, 0.3],
      sessionId: 'session-1',
      isCore: false,
      recallCount: 0,
      lastRecalled: 0,
    };

    storage.store(memory);
    const result = storage.getById('test-1');

    expect(result).toBeDefined();
    expect(result!.content).toBe('We chose Redis for search');
    expect(result!.tags).toEqual(['redis', 'architecture']);
  });

  it('lists memories by project', () => {
    storage.store(makeMemory('m-1', 'proj-a'));
    storage.store(makeMemory('m-2', 'proj-a'));
    storage.store(makeMemory('m-3', 'proj-b'));

    const results = storage.listByProject('proj-a');
    expect(results).toHaveLength(2);
  });

  it('returns all memories for hydration', () => {
    storage.store(makeMemory('m-1', 'proj-a'));
    storage.store(makeMemory('m-2', 'proj-a'));

    const all = storage.getAll();
    expect(all).toHaveLength(2);
  });

  it('stores and retrieves core memory fields', () => {
    const memory = makeMemory('core-1', 'proj-a');
    memory.isCore = true;
    memory.recallCount = 5;
    storage.store(memory);

    const result = storage.getById('core-1');
    expect(result).toBeDefined();
    expect(result!.isCore).toBe(true);
    expect(result!.recallCount).toBe(5);
  });

  it('returns core memories only', () => {
    const core = makeMemory('c-1', 'proj-a');
    core.isCore = true;
    storage.store(core);
    storage.store(makeMemory('n-1', 'proj-a'));
    storage.store(makeMemory('n-2', 'proj-a'));

    const results = storage.getCoreMemories();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('c-1');
  });

  it('increments recall count', () => {
    storage.store(makeMemory('r-1', 'proj-a'));
    storage.incrementRecallCount('r-1');
    storage.incrementRecallCount('r-1');

    const result = storage.getById('r-1');
    expect(result!.recallCount).toBe(2);
    expect(result!.lastRecalled).toBeGreaterThan(0);
  });

  it('promotes memory to core', () => {
    storage.store(makeMemory('p-1', 'proj-a'));
    expect(storage.getById('p-1')!.isCore).toBe(false);

    storage.setCore('p-1', true);
    expect(storage.getById('p-1')!.isCore).toBe(true);
  });

  it('replaces memory content on merge', () => {
    const memory = makeMemory('mg-1', 'proj-a');
    memory.recallCount = 2;
    storage.store(memory);

    const newEmbedding = Buffer.from(new Float32Array([0.5, 0.6]).buffer);
    storage.mergeContent('mg-1', 'Updated content', newEmbedding);

    const result = storage.getById('mg-1');
    expect(result!.content).toBe('Updated content');
    expect(result!.recallCount).toBe(2);
  });
});

describe('memory_edges table', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    storage = new SqliteStorage(TEST_DB);
  });

  afterEach(() => {
    storage.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should create memory_edges table on migration', () => {
    const db = (storage as any).db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_edges'").all();
    expect(tables).toHaveLength(1);
  });

  it('should have correct schema with composite primary key', () => {
    const db = (storage as any).db;
    const columns = db.pragma('table_info(memory_edges)') as any[];
    const names = columns.map((c: any) => c.name);
    expect(names).toContain('source_id');
    expect(names).toContain('target_id');
    expect(names).toContain('similarity');
    expect(names).toContain('created_at');
  });
});

function makeMemory(id: string, project: string): Memory {
  return {
    id,
    timestamp: Date.now(),
    project,
    scope: 'project',
    type: 'fact',
    content: `Memory ${id}`,
    tags: [],
    embedding: [],
    sessionId: 'test-session',
    isCore: false,
    recallCount: 0,
    lastRecalled: 0,
  };
}
