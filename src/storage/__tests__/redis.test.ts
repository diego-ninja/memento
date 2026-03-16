import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RedisStorage } from '../redis.js';
import type { Memory } from '../../types.js';

describe('RedisStorage', () => {
  let storage: RedisStorage;

  beforeEach(async () => {
    storage = new RedisStorage({ host: '127.0.0.1', port: 6380 }, 'test');
    await storage.connect();
    await storage.flush();
  });

  afterEach(async () => {
    await storage.flush();
    await storage.disconnect();
  });

  it('stores and retrieves a memory by id', async () => {
    const memory = makeMemory('r-1');
    await storage.store(memory);
    const result = await storage.getById('r-1');

    expect(result).toBeDefined();
    expect(result!.content).toBe('Memory r-1');
  });

  it('searches by text query', async () => {
    await storage.store(makeMemory('r-1', 'Redis is fast for search'));
    await storage.store(makeMemory('r-2', 'SQLite is great for persistence'));

    const results = await storage.searchText('Redis search');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('r-1');
  });

  it('searches by vector similarity', async () => {
    const embedding = new Array(768).fill(0).map(() => Math.random());
    await storage.store({ ...makeMemory('r-1'), embedding });

    const results = await storage.searchVector(embedding, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('stores and retrieves core memory fields', async () => {
    const memory = makeMemory('r-core', 'Core memory');
    memory.isCore = true;
    memory.recallCount = 3;
    await storage.store(memory);

    const result = await storage.getById('r-core');
    expect(result).toBeDefined();
    expect(result!.isCore).toBe(true);
    expect(result!.recallCount).toBe(3);
  });

  it('filters core memories', async () => {
    const core = makeMemory('r-core', 'Core memory');
    core.isCore = true;
    await storage.store(core);
    await storage.store(makeMemory('r-normal', 'Normal memory'));

    const results = await storage.getCoreMemories();
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('r-core');
    expect(results[0].isCore).toBe(true);
  });

  it('increments recall count', async () => {
    await storage.store(makeMemory('r-recall'));
    const before = Date.now();
    await storage.incrementRecallCount('r-recall');
    const result = await storage.getById('r-recall');

    expect(result).toBeDefined();
    expect(result!.recallCount).toBe(1);
    expect(result!.lastRecalled).toBeGreaterThanOrEqual(before);
  });

  it('flushes all memories with test prefix', async () => {
    await storage.store(makeMemory('r-1'));
    await storage.flush();
    const result = await storage.getById('r-1');
    expect(result).toBeUndefined();
  });
});

function makeMemory(id: string, content?: string): Memory {
  return {
    id,
    timestamp: Date.now(),
    project: 'test-project',
    scope: 'project',
    type: 'fact',
    content: content ?? `Memory ${id}`,
    tags: ['test'],
    embedding: new Array(768).fill(0),
    sessionId: 'test-session',
    isCore: false,
    recallCount: 0,
    lastRecalled: 0,
  };
}
