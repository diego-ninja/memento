import { RedisStorage } from './redis.js';
import { SqliteStorage } from './sqlite.js';
import type { Memory } from '../types.js';

export class SyncStorage {
  private redis: RedisStorage;
  private sqlite: SqliteStorage;

  constructor(
    redisConfig: { host: string; port: number },
    sqlitePath: string,
    namespace: string = 'memento',
  ) {
    this.redis = new RedisStorage(redisConfig, namespace);
    this.sqlite = new SqliteStorage(sqlitePath);
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async disconnect(): Promise<void> {
    await this.redis.disconnect();
    this.sqlite.close();
  }

  async store(memory: Memory): Promise<void> {
    this.sqlite.store(memory);
    await this.redis.store(memory);
  }

  async needsHydrate(): Promise<boolean> {
    const redisCount = await this.redis.count();
    return redisCount === 0;
  }

  async hydrate(): Promise<void> {
    const all = this.sqlite.getAll();
    for (const memory of all) {
      await this.redis.store(memory);
    }
  }

  async flush(): Promise<void> {
    await this.redis.flush();
  }

  getCoreMemories(): Memory[] {
    return this.sqlite.getCoreMemories();
  }

  async incrementRecallCount(id: string): Promise<void> {
    this.sqlite.incrementRecallCount(id);
    await this.redis.incrementRecallCount(id).catch(() => {});
  }

  async setCore(id: string, isCore: boolean): Promise<void> {
    this.sqlite.setCore(id, isCore);
    await this.redis.setCore(id, isCore).catch(() => {});
  }

  async mergeMemory(id: string, content: string, embedding: number[]): Promise<void> {
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);
    this.sqlite.mergeContent(id, content, embeddingBuffer);
    await this.redis.updateContent(id, content, embedding).catch(() => {});
  }

  async deleteMemory(id: string): Promise<void> {
    this.sqlite.deleteMemory(id);
    await this.redis.delete(id).catch(() => {});
  }

  get sqliteDb(): SqliteStorage {
    return this.sqlite;
  }

  get search() {
    return {
      text: (query: string, limit?: number) => this.redis.searchText(query, limit),
      vector: (embedding: number[], limit?: number) => this.redis.searchVector(embedding, limit),
      count: () => this.redis.count(),
    };
  }

  async getFromRedis(id: string) { return this.redis.getById(id); }
  getFromSqlite(id: string) { return this.sqlite.getById(id); }
  storeInSqliteOnly(memory: Memory) { this.sqlite.store(memory); }
}
