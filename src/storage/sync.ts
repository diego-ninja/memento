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

  async hydrate(): Promise<void> {
    const all = this.sqlite.getAll();
    for (const memory of all) {
      await this.redis.store(memory);
    }
  }

  async flush(): Promise<void> {
    await this.redis.flush();
  }

  get search() {
    return {
      text: (query: string, limit?: number) => this.redis.searchText(query, limit),
      vector: (embedding: number[], limit?: number) => this.redis.searchVector(embedding, limit),
      hybrid: (query: string, embedding: number[], limit?: number) => this.redis.searchHybrid(query, embedding, limit),
      count: () => this.redis.count(),
    };
  }

  async getFromRedis(id: string) { return this.redis.getById(id); }
  getFromSqlite(id: string) { return this.sqlite.getById(id); }
  storeInSqliteOnly(memory: Memory) { this.sqlite.store(memory); }
}
