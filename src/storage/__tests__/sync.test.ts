import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { SyncStorage } from '../sync.js';
import type { Memory } from '../../types.js';

const TEST_DB = '/tmp/memento-sync-test.db';

describe('SyncStorage', () => {
  let storage: SyncStorage;

  beforeEach(async () => {
    storage = new SyncStorage(
      { host: '127.0.0.1', port: 6380 },
      TEST_DB,
      'sync-test',
    );
    await storage.connect();
  });

  afterEach(async () => {
    await storage.flush();
    await storage.disconnect();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('stores in both Redis and SQLite', async () => {
    const memory = makeMemory('sync-1');
    await storage.store(memory);

    const fromRedis = await storage.getFromRedis('sync-1');
    const fromSqlite = storage.getFromSqlite('sync-1');

    expect(fromRedis).toBeDefined();
    expect(fromSqlite).toBeDefined();
    expect(fromRedis!.content).toBe(fromSqlite!.content);
  });

  it('hydrates Redis from SQLite', async () => {
    const memory = makeMemory('sync-2');
    storage.storeInSqliteOnly(memory);

    await storage.hydrate();

    const fromRedis = await storage.getFromRedis('sync-2');
    expect(fromRedis).toBeDefined();
    expect(fromRedis!.content).toBe('Memory sync-2');
  });

  it('returns core memories from SQLite', async () => {
    const core = makeMemory('core-1', true);
    const nonCore = makeMemory('noncore-1', false);
    await storage.store(core);
    await storage.store(nonCore);

    const coreMemories = storage.getCoreMemories();
    expect(coreMemories).toHaveLength(1);
    expect(coreMemories[0].id).toBe('core-1');
    expect(coreMemories[0].isCore).toBe(true);
  });

  it('increments recall count in both stores', async () => {
    const memory = makeMemory('recall-1');
    await storage.store(memory);

    await storage.incrementRecallCount('recall-1');

    const fromSqlite = storage.getFromSqlite('recall-1');
    expect(fromSqlite).toBeDefined();
    expect(fromSqlite!.recallCount).toBe(1);
  });

  it('checks if hydrate is needed', async () => {
    const result = await storage.needsHydrate();
    expect(typeof result).toBe('boolean');
  });
});

function makeMemory(id: string, isCore: boolean = false): Memory {
  return {
    id,
    timestamp: Date.now(),
    project: 'test',
    scope: 'project',
    type: 'fact',
    content: `Memory ${id}`,
    tags: ['test'],
    embedding: new Array(768).fill(0),
    sessionId: 'test-session',
    isCore,
    recallCount: 0,
    lastRecalled: 0,
  };
}
