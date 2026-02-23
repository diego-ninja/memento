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
  };
}
