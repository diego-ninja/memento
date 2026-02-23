import { Redis } from 'ioredis';
import type { Memory } from '../types.js';

const EMBEDDING_DIM = 768;

export class RedisStorage {
  private client: Redis;
  private prefix: string;
  private indexName: string;

  constructor(config: { host: string; port: number }, namespace: string = 'memento') {
    this.client = new Redis({ host: config.host, port: config.port, lazyConnect: true });
    this.prefix = `${namespace}:MEMORY:`;
    this.indexName = `${namespace}:idx:memories`;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.ensureIndex();
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  private async ensureIndex(): Promise<void> {
    try {
      await this.client.call('FT.INFO', this.indexName);
    } catch {
      await this.client.call(
        'FT.CREATE', this.indexName,
        'ON', 'HASH',
        'PREFIX', '1', this.prefix,
        'SCHEMA',
        'content', 'TEXT', 'WEIGHT', '1.0',
        'type', 'TAG',
        'project', 'TAG',
        'scope', 'TAG',
        'tags', 'TAG', 'SEPARATOR', ',',
        'timestamp', 'NUMERIC', 'SORTABLE',
        'session_id', 'TAG',
        'supersedes', 'TAG',
        'embedding', 'VECTOR', 'HNSW', '6',
          'TYPE', 'FLOAT32',
          'DIM', String(EMBEDDING_DIM),
          'DISTANCE_METRIC', 'COSINE',
      );
    }
  }

  async store(memory: Memory): Promise<void> {
    const key = `${this.prefix}${memory.id}`;
    const embeddingBuffer = Buffer.from(new Float32Array(memory.embedding).buffer);

    await this.client.hset(key, {
      content: memory.content,
      type: memory.type,
      project: memory.project,
      scope: memory.scope,
      tags: memory.tags.join(','),
      timestamp: String(memory.timestamp),
      session_id: memory.sessionId,
      supersedes: memory.supersedes ?? '',
      embedding: embeddingBuffer,
    });
  }

  async getById(id: string): Promise<Memory | undefined> {
    const key = `${this.prefix}${id}`;
    const data = await this.client.hgetallBuffer(key);
    if (!data || Object.keys(data).length === 0) return undefined;
    return this.hashToMemory(id, data);
  }

  async searchText(query: string, limit: number = 20): Promise<Memory[]> {
    const escaped = this.escapeQuery(query);
    const results = await this.client.call(
      'FT.SEARCH', this.indexName,
      escaped,
      'SORTBY', 'timestamp', 'DESC',
      'LIMIT', '0', String(limit),
    ) as any[];
    return this.parseSearchResults(results);
  }

  async searchVector(embedding: number[], limit: number = 20): Promise<Memory[]> {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    const results = await this.client.call(
      'FT.SEARCH', this.indexName,
      `*=>[KNN ${limit} @embedding $vec AS score]`,
      'PARAMS', '2', 'vec', buffer,
      'SORTBY', 'score',
      'LIMIT', '0', String(limit),
      'DIALECT', '2',
    ) as any[];
    return this.parseSearchResults(results);
  }

  async searchHybrid(textQuery: string, embedding: number[], limit: number = 20): Promise<Memory[]> {
    const escaped = this.escapeQuery(textQuery);
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    const results = await this.client.call(
      'FT.SEARCH', this.indexName,
      `(${escaped})=>[KNN ${limit} @embedding $vec AS vector_score]`,
      'PARAMS', '2', 'vec', buffer,
      'SORTBY', 'vector_score',
      'LIMIT', '0', String(limit),
      'DIALECT', '2',
    ) as any[];
    return this.parseSearchResults(results);
  }

  async flush(): Promise<void> {
    const keys = await this.client.keys(`${this.prefix}*`);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
    try {
      await this.client.call('FT.DROPINDEX', this.indexName);
    } catch { /* index might not exist */ }
    await this.ensureIndex();
  }

  async count(): Promise<number> {
    const info = await this.client.call('FT.INFO', this.indexName) as any[];
    const numDocsIdx = info.indexOf('num_docs');
    return numDocsIdx >= 0 ? Number(info[numDocsIdx + 1]) : 0;
  }

  private escapeQuery(query: string): string {
    return query.replace(/[^\w\s]/g, ' ').trim() || '*';
  }

  private parseSearchResults(results: any[]): Memory[] {
    if (!results || results[0] === 0) return [];
    const memories: Memory[] = [];
    for (let i = 1; i < results.length; i += 2) {
      const key = String(results[i]);
      const id = key.replace(this.prefix, '');
      const fields = results[i + 1] as any[];
      const hash: Record<string, any> = {};
      for (let j = 0; j < fields.length; j += 2) {
        hash[String(fields[j])] = fields[j + 1];
      }
      memories.push(this.rawHashToMemory(id, hash));
    }
    return memories;
  }

  private hashToMemory(id: string, data: Record<string, Buffer>): Memory {
    const str = (key: string) => data[key]?.toString('utf-8') ?? '';
    const embBuf = data['embedding'];
    const embedding = embBuf && embBuf.length > 0
      ? Array.from(new Float32Array(new Uint8Array(embBuf).buffer))
      : [];

    return {
      id,
      timestamp: Number(str('timestamp')),
      project: str('project'),
      scope: str('scope') as Memory['scope'],
      type: str('type') as Memory['type'],
      content: str('content'),
      tags: str('tags') ? str('tags').split(',') : [],
      embedding,
      sessionId: str('session_id'),
      supersedes: str('supersedes') || undefined,
    };
  }

  private rawHashToMemory(id: string, data: Record<string, any>): Memory {
    const str = (key: string) => (data[key] != null ? String(data[key]) : '');
    return {
      id,
      timestamp: Number(str('timestamp')),
      project: str('project'),
      scope: str('scope') as Memory['scope'],
      type: str('type') as Memory['type'],
      content: str('content'),
      tags: str('tags') ? str('tags').split(',') : [],
      embedding: [],
      sessionId: str('session_id'),
      supersedes: str('supersedes') || undefined,
    };
  }
}
