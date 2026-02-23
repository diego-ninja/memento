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
});

function makeMemory(id: string): Memory {
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
  };
}
