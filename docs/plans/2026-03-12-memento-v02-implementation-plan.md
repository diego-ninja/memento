# Memento v0.2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use viterbit:executing-plans to implement this plan task-by-task.

**Goal:** Optimize Memento for minimal context consumption, reliable search via RRF, autonomous hooks, core memory hierarchy, and memory merging.

**Architecture:** Dual-tier memory (core/archival) with RRF search, telegraphic format, lazy hydrate, autonomous extraction via Ollama generative model in hooks.

**Tech Stack:** TypeScript, Redis Stack (RediSearch + HNSW), SQLite, Ollama (nomic-embed-text + qwen2.5:3b), vitest

**Design doc:** `docs/plans/2026-03-12-memento-optimization-design.md`

---

## Phase 1: Schema & Types (foundation)

### Task 1: Update Memory type and config

**Files:**
- Modify: `src/types.ts`

**Step 1: Update the Memory interface and config**

Add new fields to `Memory`, simplify `MemoryInput`, update config, remove `ExtractResult`:

```typescript
export type MemoryType = 'decision' | 'learning' | 'preference' | 'context' | 'fact';
export type MemoryScope = 'global' | 'project';

export interface Memory {
  id: string;
  timestamp: number;
  project: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  tags: string[];
  embedding: number[];
  sessionId: string;
  supersedes?: string;
  isCore: boolean;
  recallCount: number;
  lastRecalled: number;
}

export interface MemoryInput {
  type: MemoryType;
  content: string;
  core?: boolean;
}

export interface RecallResult {
  memory: Memory;
  score: number;
  source: 'text' | 'vector' | 'rrf';
}

export interface RecallQuery {
  query: string;
  project?: string;
  scope?: MemoryScope;
  type?: MemoryType;
  limit?: number;
}

export interface MementoConfig {
  dataDir: string;
  redis: {
    host: string;
    port: number;
  };
  ollama: {
    host: string;
    embeddingModel: string;
    generativeModel: string;
  };
  search: {
    topK: number;
    finalK: number;
    deduplicationThreshold: number;
    mergeThreshold: number;
    rrfK: number;
  };
  core: {
    promoteAfterRecalls: number;
    degradeAfterSessions: number;
  };
  extraction: {
    provider: 'ollama' | 'anthropic';
    ollama: { model: string };
    anthropic: { model: string };
  };
}
```

**Step 2: Update config defaults**

Modify `src/config.ts` — update `DEFAULT_CONFIG` to match the new `MementoConfig`:

```typescript
const DEFAULT_CONFIG: MementoConfig = {
  dataDir: MEMENTO_DIR,
  redis: {
    host: process.env.MEMENTO_REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.MEMENTO_REDIS_PORT ?? 6380),
  },
  ollama: {
    host: process.env.MEMENTO_OLLAMA_HOST ?? 'http://127.0.0.1:11435',
    embeddingModel: 'nomic-embed-text',
    generativeModel: 'qwen2.5:3b',
  },
  search: {
    topK: 20,
    finalK: 3,
    deduplicationThreshold: 0.92,
    mergeThreshold: 0.80,
    rrfK: 60,
  },
  core: {
    promoteAfterRecalls: 3,
    degradeAfterSessions: 30,
  },
  extraction: {
    provider: 'ollama',
    ollama: { model: 'qwen2.5:3b' },
    anthropic: { model: 'claude-haiku-4-5-20251001' },
  },
};
```

Also update `OllamaEmbeddings` constructor call in `server.ts` will need to use `config.ollama.embeddingModel` (done in Task 9).

**Step 3: Build to check types compile**

Run: `npx tsc --noEmit`
Expected: type errors in storage/tools/server files (they reference old fields). That's expected — we fix them in subsequent tasks.

**Step 4: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: update schema with core memory, recall tracking, and merge config"
```

---

## Phase 2: Storage layer

### Task 2: Update SQLite storage

**Files:**
- Modify: `src/storage/sqlite.ts`
- Modify: `src/storage/__tests__/sqlite.test.ts`

**Step 1: Write failing tests for new fields**

Add to `src/storage/__tests__/sqlite.test.ts`:

```typescript
it('stores and retrieves core memory fields', () => {
  const memory: Memory = {
    ...makeMemory('core-1', 'proj-a'),
    isCore: true,
    recallCount: 5,
    lastRecalled: Date.now(),
  };

  storage.store(memory);
  const result = storage.getById('core-1');

  expect(result!.isCore).toBe(true);
  expect(result!.recallCount).toBe(5);
  expect(result!.lastRecalled).toBeGreaterThan(0);
});

it('returns core memories only', () => {
  storage.store({ ...makeMemory('c-1', 'proj-a'), isCore: true, recallCount: 0, lastRecalled: 0 });
  storage.store({ ...makeMemory('a-1', 'proj-a'), isCore: false, recallCount: 0, lastRecalled: 0 });
  storage.store({ ...makeMemory('a-2', 'proj-a'), isCore: false, recallCount: 0, lastRecalled: 0 });

  const core = storage.getCoreMemories();
  expect(core).toHaveLength(1);
  expect(core[0].id).toBe('c-1');
});

it('increments recall count', () => {
  storage.store({ ...makeMemory('rc-1', 'proj-a'), isCore: false, recallCount: 0, lastRecalled: 0 });
  storage.incrementRecallCount('rc-1');
  storage.incrementRecallCount('rc-1');

  const result = storage.getById('rc-1');
  expect(result!.recallCount).toBe(2);
  expect(result!.lastRecalled).toBeGreaterThan(0);
});

it('promotes memory to core', () => {
  storage.store({ ...makeMemory('p-1', 'proj-a'), isCore: false, recallCount: 0, lastRecalled: 0 });
  storage.setCore('p-1', true);

  const result = storage.getById('p-1');
  expect(result!.isCore).toBe(true);
});

it('replaces memory content on merge', () => {
  storage.store({ ...makeMemory('merge-1', 'proj-a'), isCore: false, recallCount: 2, lastRecalled: 100 });
  storage.mergeContent('merge-1', 'merged content', new Float32Array([0.5, 0.6]).buffer);

  const result = storage.getById('merge-1');
  expect(result!.content).toBe('merged content');
  expect(result!.recallCount).toBe(2); // preserved
});
```

Update `makeMemory` helper to include new fields:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/__tests__/sqlite.test.ts`
Expected: FAIL — new fields don't exist, new methods don't exist.

**Step 3: Update SqliteStorage implementation**

Modify `src/storage/sqlite.ts`:

1. Update `migrate()` to add new columns (with migration for existing DBs):

```typescript
private migrate(): void {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      project TEXT NOT NULL,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL,
      embedding BLOB NOT NULL,
      session_id TEXT NOT NULL,
      supersedes TEXT,
      is_core INTEGER NOT NULL DEFAULT 0,
      recall_count INTEGER NOT NULL DEFAULT 0,
      last_recalled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_memories_is_core ON memories(is_core);
  `);

  // Migration for existing DBs
  const columns = this.db.pragma('table_info(memories)') as { name: string }[];
  const colNames = new Set(columns.map(c => c.name));
  if (!colNames.has('is_core')) {
    this.db.exec('ALTER TABLE memories ADD COLUMN is_core INTEGER NOT NULL DEFAULT 0');
  }
  if (!colNames.has('recall_count')) {
    this.db.exec('ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!colNames.has('last_recalled')) {
    this.db.exec('ALTER TABLE memories ADD COLUMN last_recalled INTEGER NOT NULL DEFAULT 0');
  }
}
```

2. Update `store()` to include new fields:

```typescript
store(memory: Memory): void {
  const stmt = this.db.prepare(`
    INSERT OR REPLACE INTO memories
    (id, timestamp, project, scope, type, content, tags, embedding, session_id, supersedes, is_core, recall_count, last_recalled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    memory.id,
    memory.timestamp,
    memory.project,
    memory.scope,
    memory.type,
    memory.content,
    JSON.stringify(memory.tags),
    Buffer.from(new Float32Array(memory.embedding).buffer),
    memory.sessionId,
    memory.supersedes ?? null,
    memory.isCore ? 1 : 0,
    memory.recallCount,
    memory.lastRecalled,
  );
}
```

3. Add new methods:

```typescript
getCoreMemories(): Memory[] {
  const rows = this.db
    .prepare('SELECT * FROM memories WHERE is_core = 1 ORDER BY timestamp DESC')
    .all() as any[];
  return rows.map(this.rowToMemory);
}

incrementRecallCount(id: string): void {
  this.db.prepare(
    'UPDATE memories SET recall_count = recall_count + 1, last_recalled = ? WHERE id = ?'
  ).run(Date.now(), id);
}

setCore(id: string, isCore: boolean): void {
  this.db.prepare('UPDATE memories SET is_core = ? WHERE id = ?').run(isCore ? 1 : 0, id);
}

mergeContent(id: string, content: string, embeddingBuffer: ArrayBuffer): void {
  this.db.prepare(
    'UPDATE memories SET content = ?, embedding = ?, timestamp = ? WHERE id = ?'
  ).run(content, Buffer.from(embeddingBuffer), Date.now(), id);
}
```

4. Update `rowToMemory()`:

```typescript
private rowToMemory(row: any): Memory {
  return {
    id: row.id,
    timestamp: row.timestamp,
    project: row.project,
    scope: row.scope,
    type: row.type,
    content: row.content,
    tags: JSON.parse(row.tags),
    embedding:
      row.embedding.length > 0
        ? Array.from(new Float32Array(new Uint8Array(row.embedding).buffer))
        : [],
    sessionId: row.session_id,
    supersedes: row.supersedes ?? undefined,
    isCore: row.is_core === 1,
    recallCount: row.recall_count ?? 0,
    lastRecalled: row.last_recalled ?? 0,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/__tests__/sqlite.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/storage/sqlite.ts src/storage/__tests__/sqlite.test.ts
git commit -m "feat: add core memory, recall tracking, and merge to SQLite storage"
```

---

### Task 3: Update Redis storage

**Files:**
- Modify: `src/storage/redis.ts`
- Modify: `src/storage/__tests__/redis.test.ts`

**Step 1: Write failing tests**

Add to `src/storage/__tests__/redis.test.ts`:

```typescript
it('stores and retrieves core memory fields', async () => {
  const memory = { ...makeMemory('r-core'), isCore: true, recallCount: 3, lastRecalled: Date.now() };
  await storage.store(memory);
  const result = await storage.getById('r-core');

  expect(result!.isCore).toBe(true);
  expect(result!.recallCount).toBe(3);
});

it('filters core memories', async () => {
  await storage.store({ ...makeMemory('r-c1'), isCore: true, recallCount: 0, lastRecalled: 0 });
  await storage.store({ ...makeMemory('r-a1'), isCore: false, recallCount: 0, lastRecalled: 0 });

  const core = await storage.getCoreMemories();
  expect(core).toHaveLength(1);
  expect(core[0].id).toBe('r-c1');
});

it('increments recall count', async () => {
  await storage.store({ ...makeMemory('r-rc1'), isCore: false, recallCount: 0, lastRecalled: 0 });
  await storage.incrementRecallCount('r-rc1');

  const result = await storage.getById('r-rc1');
  expect(result!.recallCount).toBe(1);
  expect(result!.lastRecalled).toBeGreaterThan(0);
});
```

Update `makeMemory`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/__tests__/redis.test.ts`
Expected: FAIL

**Step 3: Update RedisStorage implementation**

Modify `src/storage/redis.ts`:

1. Update `ensureIndex()` — need to drop and recreate index with new fields. Add a version check:

```typescript
private async ensureIndex(): Promise<void> {
  try {
    const info = await this.client.call('FT.INFO', this.indexName) as any[];
    const fields = info[info.indexOf('attributes') + 1] as any[];
    const fieldNames = new Set<string>();
    for (const f of fields) {
      if (Array.isArray(f)) fieldNames.add(String(f[1]));
    }
    if (!fieldNames.has('is_core')) {
      await this.client.call('FT.DROPINDEX', this.indexName);
      throw new Error('reindex');
    }
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
      'is_core', 'TAG',
      'recall_count', 'NUMERIC', 'SORTABLE',
      'last_recalled', 'NUMERIC', 'SORTABLE',
      'embedding', 'VECTOR', 'HNSW', '6',
        'TYPE', 'FLOAT32',
        'DIM', String(EMBEDDING_DIM),
        'DISTANCE_METRIC', 'COSINE',
    );
  }
}
```

2. Update `store()` to include new fields:

```typescript
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
    is_core: memory.isCore ? '1' : '0',
    recall_count: String(memory.recallCount),
    last_recalled: String(memory.lastRecalled),
    embedding: embeddingBuffer,
  });
}
```

3. Add new methods:

```typescript
async getCoreMemories(): Promise<Memory[]> {
  const results = await this.client.call(
    'FT.SEARCH', this.indexName,
    '@is_core:{1}',
    'SORTBY', 'timestamp', 'DESC',
    'LIMIT', '0', '20',
  ) as any[];
  return this.parseSearchResults(results);
}

async incrementRecallCount(id: string): Promise<void> {
  const key = `${this.prefix}${id}`;
  await this.client.hincrby(key, 'recall_count', 1);
  await this.client.hset(key, 'last_recalled', String(Date.now()));
}

async setCore(id: string, isCore: boolean): Promise<void> {
  const key = `${this.prefix}${id}`;
  await this.client.hset(key, 'is_core', isCore ? '1' : '0');
}

async updateContent(id: string, content: string, embedding: number[]): Promise<void> {
  const key = `${this.prefix}${id}`;
  const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);
  await this.client.hset(key, {
    content,
    embedding: embeddingBuffer,
    timestamp: String(Date.now()),
  });
}
```

4. Update both `hashToMemory()` and `rawHashToMemory()` to include new fields:

```typescript
// In hashToMemory:
isCore: str('is_core') === '1',
recallCount: Number(str('recall_count')) || 0,
lastRecalled: Number(str('last_recalled')) || 0,

// In rawHashToMemory:
isCore: str('is_core') === '1',
recallCount: Number(str('recall_count')) || 0,
lastRecalled: Number(str('last_recalled')) || 0,
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/__tests__/redis.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/storage/redis.ts src/storage/__tests__/redis.test.ts
git commit -m "feat: add core memory, recall tracking to Redis storage"
```

---

### Task 4: Update SyncStorage

**Files:**
- Modify: `src/storage/sync.ts`
- Modify: `src/storage/__tests__/sync.test.ts`

**Step 1: Write failing test**

Add to `src/storage/__tests__/sync.test.ts`:

```typescript
it('returns core memories from SQLite', async () => {
  await storage.store({ ...makeMemory('sc-1'), isCore: true });
  await storage.store({ ...makeMemory('sc-2'), isCore: false });

  const core = storage.getCoreMemories();
  expect(core).toHaveLength(1);
  expect(core[0].id).toBe('sc-1');
});

it('increments recall count in both stores', async () => {
  await storage.store(makeMemory('src-1'));
  await storage.incrementRecallCount('src-1');

  const fromSqlite = storage.getFromSqlite('src-1');
  expect(fromSqlite!.recallCount).toBe(1);
});

it('checks if hydrate is needed', async () => {
  const needed = await storage.needsHydrate();
  // After connect + flush, Redis is empty but no data in SQLite either
  expect(typeof needed).toBe('boolean');
});
```

Update `makeMemory`:

```typescript
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
    isCore: false,
    recallCount: 0,
    lastRecalled: 0,
  };
}
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/__tests__/sync.test.ts`
Expected: FAIL

**Step 3: Update SyncStorage**

Replace `src/storage/sync.ts`:

```typescript
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
    const embeddingBuffer = new Float32Array(embedding).buffer;
    this.sqlite.mergeContent(id, content, embeddingBuffer);
    await this.redis.updateContent(id, content, embedding).catch(() => {});
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
```

Note: removed `hybrid` from `search` getter — RRF replaces it (Phase 3).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/__tests__/sync.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/storage/sync.ts src/storage/__tests__/sync.test.ts
git commit -m "feat: add core memory and recall tracking to SyncStorage"
```

---

## Phase 3: Search layer (RRF + Reranker)

### Task 5: Implement RRF search

**Files:**
- Rewrite: `src/search/hybrid.ts` → RRF logic
- Create: `src/search/__tests__/rrf.test.ts`

**Step 1: Write RRF unit tests**

Create `src/search/__tests__/rrf.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { rrfFuse } from '../hybrid.js';
import type { Memory } from '../../types.js';

function mem(id: string): Memory {
  return {
    id, timestamp: Date.now(), project: 'test', scope: 'project',
    type: 'fact', content: `Memory ${id}`, tags: [], embedding: [],
    sessionId: 'test', isCore: false, recallCount: 0, lastRecalled: 0,
  };
}

describe('rrfFuse', () => {
  it('boosts memories appearing in both lists', () => {
    const textResults = [mem('a'), mem('b'), mem('c')];
    const vectorResults = [mem('b'), mem('d'), mem('a')];

    const fused = rrfFuse(textResults, vectorResults, 60);

    // 'b' and 'a' appear in both lists, should rank highest
    const ids = fused.map(r => r.memory.id);
    expect(ids[0]).toBe('a'); // rank 1 in text + rank 3 in vector
    expect(ids[1]).toBe('b'); // rank 2 in text + rank 1 in vector
  });

  it('includes memories from only one list', () => {
    const textResults = [mem('a')];
    const vectorResults = [mem('b')];

    const fused = rrfFuse(textResults, vectorResults, 60);
    expect(fused).toHaveLength(2);
  });

  it('returns empty for empty inputs', () => {
    const fused = rrfFuse([], [], 60);
    expect(fused).toHaveLength(0);
  });

  it('deduplicates by id', () => {
    const textResults = [mem('a'), mem('a')];
    const vectorResults = [mem('a')];

    const fused = rrfFuse(textResults, vectorResults, 60);
    expect(fused).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/search/__tests__/rrf.test.ts`
Expected: FAIL — `rrfFuse` not exported

**Step 3: Rewrite HybridSearch with RRF**

Replace `src/search/hybrid.ts`:

```typescript
import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { Memory, RecallQuery, RecallResult } from '../types.js';

export class HybridSearch {
  constructor(
    private storage: SyncStorage,
    private embeddings: OllamaEmbeddings,
    private rrfK: number = 60,
  ) {}

  async search(query: RecallQuery): Promise<RecallResult[]> {
    const embedding = await this.embeddings.generate(query.query);
    const limit = query.limit ?? 20;

    const [textResults, vectorResults] = await Promise.all([
      this.storage.search.text(query.query, limit).catch(() => [] as Memory[]),
      this.storage.search.vector(embedding, limit).catch(() => [] as Memory[]),
    ]);

    return rrfFuse(textResults, vectorResults, this.rrfK);
  }
}

export function rrfFuse(
  textResults: Memory[],
  vectorResults: Memory[],
  k: number,
): RecallResult[] {
  const scores = new Map<string, { memory: Memory; score: number }>();

  for (let i = 0; i < textResults.length; i++) {
    const mem = textResults[i];
    const existing = scores.get(mem.id);
    const rrfScore = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(mem.id, { memory: mem, score: rrfScore });
    }
  }

  for (let i = 0; i < vectorResults.length; i++) {
    const mem = vectorResults[i];
    const existing = scores.get(mem.id);
    const rrfScore = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(mem.id, { memory: mem, score: rrfScore });
    }
  }

  const results: RecallResult[] = Array.from(scores.values()).map(({ memory, score }) => ({
    memory,
    score,
    source: 'rrf' as const,
  }));

  results.sort((a, b) => b.score - a.score);
  return results;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/search/__tests__/rrf.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/search/hybrid.ts src/search/__tests__/rrf.test.ts
git commit -m "feat: replace cascade fallback with RRF search fusion"
```

---

### Task 6: Update Reranker with recall_count boost

**Files:**
- Modify: `src/search/reranker.ts`
- Modify: `src/search/__tests__/reranker.test.ts`

**Step 1: Write failing test**

Add to `src/search/__tests__/reranker.test.ts`:

```typescript
it('boosts frequently recalled memories', () => {
  const now = Date.now();
  const results: RecallResult[] = [
    makeResult('rarely', 0.5, now, 'fact', 0),
    makeResult('often', 0.5, now, 'fact', 10),
  ];

  const ranked = reranker.rerank(results, 5);
  expect(ranked[0].memory.id).toBe('often');
});
```

Update `makeResult` to accept recallCount:

```typescript
function makeResult(id: string, score: number, timestamp: number, type: string = 'fact', recallCount: number = 0): RecallResult {
  return {
    memory: {
      id, timestamp, project: 'test', scope: 'project',
      type: type as any, content: `Memory ${id}`,
      tags: [], embedding: [], sessionId: 'test',
      isCore: false, recallCount, lastRecalled: 0,
    },
    score, source: 'rrf',
  };
}
```

Also update existing `makeResult` calls that don't pass `recallCount` — they'll get default `0`.

**Step 2: Run tests to verify the new one fails**

Run: `npx vitest run src/search/__tests__/reranker.test.ts`
Expected: new test FAILS (reranker doesn't consider recallCount yet)

**Step 3: Update Reranker**

Replace `src/search/reranker.ts`:

```typescript
import type { RecallResult, MemoryType } from '../types.js';

const TYPE_WEIGHTS: Record<MemoryType, number> = {
  decision: 1.3,
  learning: 1.2,
  preference: 1.15,
  fact: 1.0,
  context: 0.9,
};

const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export class Reranker {
  rerank(results: RecallResult[], finalK: number): RecallResult[] {
    const supersededIds = new Set(
      results.map(r => r.memory.supersedes).filter(Boolean) as string[],
    );
    const filtered = results.filter(r => !supersededIds.has(r.memory.id));

    const now = Date.now();
    const scored = filtered.map(r => {
      const typeWeight = TYPE_WEIGHTS[r.memory.type] ?? 1.0;
      const age = now - r.memory.timestamp;
      const recencyBoost = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
      const recallBoost = 1 + Math.sqrt(r.memory.recallCount) * 0.05;
      const finalScore = r.score * typeWeight * (0.5 + 0.5 * recencyBoost) * recallBoost;
      return { ...r, score: finalScore };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, finalK);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/search/__tests__/reranker.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/search/reranker.ts src/search/__tests__/reranker.test.ts
git commit -m "feat: add recall frequency boost to reranker"
```

---

## Phase 4: Tools (recall + remember)

### Task 7: Rewrite recall tool with compact format

**Files:**
- Modify: `src/tools/recall.ts`

**Step 1: Rewrite recall tool**

Replace `src/tools/recall.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HybridSearch } from '../search/hybrid.js';
import type { Reranker } from '../search/reranker.js';
import type { SyncStorage } from '../storage/sync.js';
import type { MementoConfig, RecallResult } from '../types.js';

const TYPE_CHAR: Record<string, string> = {
  decision: 'D', learning: 'L', preference: 'P', fact: 'F', context: 'C',
};

export function registerRecallTool(
  server: McpServer,
  search: HybridSearch,
  reranker: Reranker,
  storage: SyncStorage,
  config: MementoConfig,
): void {
  server.tool(
    'recall',
    'Search persistent memory. Returns compact results: TYPE|MMDD|content',
    {
      query: z.string().describe('Natural language query'),
      type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']).optional(),
      limit: z.number().optional().describe('Max results (default: 3)'),
    },
    async ({ query, type, limit }) => {
      const results = await search.search({
        query,
        type,
        limit: config.search.topK,
      });

      const ranked = reranker.rerank(results, limit ?? config.search.finalK);

      if (ranked.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }

      // Fire-and-forget: increment recall counts + auto-promote
      for (const r of ranked) {
        storage.incrementRecallCount(r.memory.id).then(() => {
          const newCount = r.memory.recallCount + 1;
          if (!r.memory.isCore && newCount >= config.core.promoteAfterRecalls) {
            storage.setCore(r.memory.id, true);
          }
        }).catch(() => {});
      }

      return { content: [{ type: 'text', text: formatCompact(ranked) }] };
    },
  );
}

function formatCompact(results: RecallResult[]): string {
  return results.map(r => {
    const t = TYPE_CHAR[r.memory.type] ?? '?';
    const d = new Date(r.memory.timestamp);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${t}|${mm}${dd}|${r.memory.content}`;
  }).join('\n');
}
```

Note: the function signature changes — now takes `storage` param. This is wired in Task 9 (server.ts).

**Step 2: Build to check types**

Run: `npx tsc --noEmit`
Expected: error in server.ts (missing `storage` arg to `registerRecallTool`) — fixed in Task 9.

**Step 3: Commit**

```bash
git add src/tools/recall.ts
git commit -m "feat: compact recall format and auto-promote to core"
```

---

### Task 8: Rewrite remember tool with merge + batch

**Files:**
- Modify: `src/tools/remember.ts`

**Step 1: Rewrite remember tool**

Replace `src/tools/remember.ts`:

```typescript
import { z } from 'zod';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { MementoConfig, Memory } from '../types.js';
import { getProjectId } from '../config.js';

export function registerRememberTool(
  server: McpServer,
  storage: SyncStorage,
  embeddings: OllamaEmbeddings,
  config: MementoConfig,
  projectPath: string,
  mergeWithLLM?: (old: string, new_: string) => Promise<string>,
): void {
  server.tool(
    'remember',
    'Persist memories as telegraphic notes. Content should be dense, no articles/filler: "module: key=value, fact>detail"',
    {
      memories: z.array(z.object({
        type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']),
        content: z.string().describe('Telegraphic note: dense, no filler words'),
        core: z.boolean().optional().describe('true = always loaded at session start'),
      })).describe('Memories to store'),
    },
    async ({ memories: inputs }) => {
      const sessionId = process.env.CLAUDE_SESSION_ID ?? nanoid(8);
      const projectId = getProjectId(projectPath);
      let stored = 0;
      let merged = 0;
      let deduplicated = 0;

      // Batch generate embeddings
      const contents = inputs.map(m => m.content);
      const allEmbeddings = inputs.length === 1
        ? [await embeddings.generate(contents[0])]
        : await embeddings.generateBatch(contents);

      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        const embedding = allEmbeddings[i];

        const existing = await storage.search.vector(embedding, 1);
        if (existing.length > 0) {
          const similarity = cosineSimilarity(
            embedding,
            existing[0].embedding.length > 0
              ? existing[0].embedding
              : await embeddings.generate(existing[0].content),
          );

          // Duplicate — skip
          if (similarity > config.search.deduplicationThreshold) {
            deduplicated++;
            continue;
          }

          // Merge range — fuse old + new
          if (similarity > config.search.mergeThreshold) {
            let mergedContent = input.content;
            if (mergeWithLLM) {
              try {
                mergedContent = await mergeWithLLM(existing[0].content, input.content);
              } catch {
                // Fallback: keep new content, supersede old
              }
            }
            const mergedEmbedding = await embeddings.generate(mergedContent);
            await storage.mergeMemory(existing[0].id, mergedContent, mergedEmbedding);
            merged++;
            continue;
          }
        }

        // New memory
        const memory: Memory = {
          id: nanoid(),
          timestamp: Date.now(),
          project: projectId,
          scope: 'project',
          type: input.type,
          content: input.content,
          tags: [],
          embedding,
          sessionId,
          isCore: input.core ?? false,
          recallCount: 0,
          lastRecalled: 0,
        };

        await storage.store(memory);
        stored++;
      }

      if (stored > 0 || merged > 0) {
        updateStatsCache(storage);
      }

      const parts = [`Stored ${stored}`];
      if (merged > 0) parts.push(`merged ${merged}`);
      if (deduplicated > 0) parts.push(`skipped ${deduplicated} dupes`);

      return {
        content: [{ type: 'text', text: parts.join(', ') + '.' }],
      };
    },
  );
}

const STATS_PATH = `${process.env.HOME}/.memento-stats`;

function updateStatsCache(storage: SyncStorage): void {
  storage.search.count().then(total => {
    let recalled = 0;
    try {
      const prev = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
      recalled = prev.recalled ?? 0;
    } catch { /* no previous stats */ }
    fs.writeFileSync(STATS_PATH, JSON.stringify({
      total, recalled, updated: Math.floor(Date.now() / 1000),
    }));
  }).catch(() => {});
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

Key changes:
- `tags` and `scope` removed from input schema
- `core` boolean added to input
- Batch embeddings via `generateBatch()`
- Merge via `mergeWithLLM` callback (injected from server.ts, optional)
- Response is minimal: "Stored 3, merged 1, skipped 2 dupes."

**Step 2: Build to check types**

Run: `npx tsc --noEmit`
Expected: error in server.ts (signature changed) — fixed in Task 9.

**Step 3: Commit**

```bash
git add src/tools/remember.ts
git commit -m "feat: remember with batch embeddings, merge, and simplified schema"
```

---

## Phase 5: Server + Wiring

### Task 9: Update server.ts and add Ollama merge function

**Files:**
- Modify: `src/server.ts`
- Modify: `src/embeddings/ollama.ts`
- Delete: `src/tools/remember-extract.ts`

**Step 1: Add generative method to OllamaEmbeddings**

Add to `src/embeddings/ollama.ts`:

```typescript
async merge(oldContent: string, newContent: string, model: string): Promise<string> {
  const response = await this.client.generate({
    model,
    prompt: `Merge these two memory notes into one concise telegraphic note. No articles, no filler. Keep all unique facts.\n\nOld: ${oldContent}\nNew: ${newContent}\n\nMerged:`,
    stream: false,
  });
  return response.response.trim();
}
```

**Step 2: Rewrite server.ts**

Replace `src/server.ts`:

```typescript
#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ensureDataDirs, getProjectDbPath } from './config.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';
import { registerRecallTool } from './tools/recall.js';
import { registerRememberTool } from './tools/remember.js';

async function main() {
  const config = loadConfig();
  const projectPath = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  ensureDataDirs(projectPath);

  const projectStorage = new SyncStorage(
    config.redis,
    getProjectDbPath(projectPath),
    'memento',
  );
  await projectStorage.connect();

  // Lazy hydrate: only if Redis is empty
  const needsHydrate = await projectStorage.needsHydrate();
  if (needsHydrate) {
    // Non-blocking hydrate
    projectStorage.hydrate().catch(console.error);
  }

  const embeddings = new OllamaEmbeddings({
    host: config.ollama.host,
    model: config.ollama.embeddingModel,
  });
  const search = new HybridSearch(projectStorage, embeddings, config.search.rrfK);
  const reranker = new Reranker();

  const mergeWithLLM = async (old: string, new_: string) => {
    return embeddings.merge(old, new_, config.ollama.generativeModel);
  };

  const server = new McpServer({
    name: 'memento',
    version: '0.2.0',
  });

  registerRecallTool(server, search, reranker, projectStorage, config);
  registerRememberTool(server, projectStorage, embeddings, config, projectPath, mergeWithLLM);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
```

**Step 3: Delete remember-extract.ts**

```bash
rm src/tools/remember-extract.ts
```

**Step 4: Build**

Run: `npx tsc`
Expected: BUILD SUCCESS

**Step 5: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS (some tests that import `remember-extract` would need cleanup — verify)

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire v0.2 server with lazy hydrate, RRF search, merge, remove remember_extract"
```

---

## Phase 6: CLI update

### Task 10: Add hydrate command to CLI

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add hydrate command**

Add a new case to the switch in `src/cli.ts`:

```typescript
case 'hydrate':
  await handleHydrate(config, projectPath);
  break;
```

Add the handler:

```typescript
async function handleHydrate(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const needed = await storage.needsHydrate();
  if (!needed) {
    console.log('Redis already has data. Skipping hydrate.');
    await storage.disconnect();
    return;
  }

  console.log('Hydrating Redis from SQLite...');
  await storage.hydrate();
  const count = await storage.search.count();
  console.log(`Hydrated ${count} memories.`);

  await storage.disconnect();
}
```

Also add `core` command to list core memories:

```typescript
case 'core':
  await handleCore(config, projectPath);
  break;
```

```typescript
async function handleCore(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const core = storage.getCoreMemories();
  if (core.length === 0) {
    console.log('No core memories.');
  } else {
    for (const m of core) {
      const d = new Date(m.timestamp);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const t = m.type[0].toUpperCase();
      console.log(`${t}|${mm}${dd}|${m.content}`);
    }
  }

  await storage.disconnect();
}
```

Update the usage error:

```typescript
default:
  console.error(`Unknown command: ${command}`);
  console.error('Usage: memento <recall|stats|flush|hydrate|core> [args]');
  process.exit(1);
```

**Step 2: Build and test manually**

Run: `npx tsc`
Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add hydrate and core commands to CLI"
```

---

## Phase 7: Hooks

### Task 11: Rewrite session-start hook

**Files:**
- Modify: `hooks/session-start.sh`

**Step 1: Rewrite hook**

Replace `hooks/session-start.sh`:

```bash
#!/bin/bash
# hooks/session-start.sh
# Fires on SessionStart — injects core + contextual archival memories

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# 1. Core memories (always injected)
CORE=$($CLI core 2>/dev/null || true)

# 2. Contextual archival recall
CONTEXT=""
if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
  CONTEXT=$(head -20 "$PROJECT_DIR/CLAUDE.md" 2>/dev/null | tr '\n' ' ' | cut -c1-200)
fi
QUERY="key decisions, preferences and learnings for: ${CONTEXT:-this project}"
ARCHIVAL=$($CLI recall "$QUERY" 2>/dev/null || true)

# Build output
OUTPUT=""
if [ -n "$CORE" ] && [ "$CORE" != "No core memories." ]; then
  OUTPUT="== core ==\n${CORE}"
fi
if [ -n "$ARCHIVAL" ] && [ "$ARCHIVAL" != "No relevant memories found." ]; then
  if [ -n "$OUTPUT" ]; then
    OUTPUT="${OUTPUT}\n\n== recent ==\n${ARCHIVAL}"
  else
    OUTPUT="== recent ==\n${ARCHIVAL}"
  fi
fi

if [ -z "$OUTPUT" ]; then
  # Update stats and exit
  STATS=$($CLI stats 2>/dev/null || true)
  TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")
  echo "{\"total\":$TOTAL,\"recalled\":0,\"updated\":$(date +%s)}" > "$HOME/.memento-stats"
  exit 0
fi

# Count recalled lines
RECALLED=$(echo -e "$OUTPUT" | grep -c '|' || echo "0")

# Update stats
STATS=$($CLI stats 2>/dev/null || true)
TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")
echo "{\"total\":$TOTAL,\"recalled\":$RECALLED,\"updated\":$(date +%s)}" > "$HOME/.memento-stats"

# Inject as context
jq -n --arg ctx "$(echo -e "$OUTPUT")" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("Memento — relevant memories from previous sessions:\n" + $ctx)
  }
}'
```

**Step 2: Commit**

```bash
git add hooks/session-start.sh
git commit -m "feat: session-start hook with core + contextual archival recall"
```

---

### Task 12: Implement pre-compact hook

**Files:**
- Modify: `hooks/pre-compact.sh`

**Step 1: Rewrite hook**

Replace `hooks/pre-compact.sh`:

```bash
#!/bin/bash
# hooks/pre-compact.sh
# Fires on PreCompact — reminds Claude to persist memories before context loss

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PreCompact",
    additionalContext: "MEMENTO: persist key memories now via remember() before context compaction"
  }
}'
```

**Step 2: Commit**

```bash
git add hooks/pre-compact.sh
git commit -m "feat: pre-compact hook injects extraction reminder"
```

---

### Task 13: Implement session-end hook with Ollama extraction

**Files:**
- Modify: `hooks/session-end.sh`
- Create: `src/extract.ts` (extraction logic reusable by CLI and hooks)

**Step 1: Create extraction module**

Create `src/extract.ts`:

```typescript
import { Ollama } from 'ollama';

export interface ExtractedMemory {
  type: 'decision' | 'learning' | 'preference' | 'context' | 'fact';
  content: string;
}

const EXTRACTION_PROMPT = `Extract key memories from this session transcript.
For each memory, output ONE JSON object per line (JSONL format):
{"type":"decision|learning|preference|context|fact","content":"telegraphic note, no filler"}

Rules:
- Content must be telegraphic: no articles, no filler words, dense information
- Only extract: decisions, learnings, preferences, discovered facts
- Do NOT extract: greetings, implementation details in code, trivial conversation
- Maximum 10 memories

Transcript:
`;

export async function extractFromTranscript(
  transcript: string,
  ollamaHost: string,
  model: string,
): Promise<ExtractedMemory[]> {
  const client = new Ollama({ host: ollamaHost });

  // Truncate transcript to ~4000 chars to fit small model context
  const truncated = transcript.length > 4000
    ? transcript.slice(-4000)
    : transcript;

  const response = await client.generate({
    model,
    prompt: EXTRACTION_PROMPT + truncated,
    stream: false,
  });

  return parseExtraction(response.response);
}

export function extractWithRegex(transcript: string): ExtractedMemory[] {
  const patterns = [
    /(?:decided|chosen|we agreed|architecture)\s*[:=]?\s*(.{10,100})/gi,
    /(?:prefer|always use|never use)\s+(.{10,80})/gi,
    /(?:learned|the problem was|root cause|fixed by)\s*[:=]?\s*(.{10,100})/gi,
  ];

  const memories: ExtractedMemory[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    for (const match of transcript.matchAll(pattern)) {
      const content = match[1].trim().replace(/["\n]/g, ' ');
      if (content.length < 10 || seen.has(content)) continue;
      seen.add(content);
      memories.push({ type: 'context', content });
    }
  }

  return memories.slice(0, 10);
}

function parseExtraction(raw: string): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];
  const validTypes = new Set(['decision', 'learning', 'preference', 'context', 'fact']);

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (validTypes.has(parsed.type) && typeof parsed.content === 'string') {
        memories.push({ type: parsed.type, content: parsed.content });
      }
    } catch { /* skip malformed lines */ }
  }

  return memories;
}
```

**Step 2: Add extract command to CLI**

Add to `src/cli.ts` switch:

```typescript
case 'extract':
  await handleExtract(config, projectPath, args[0]);
  break;
```

Add handler:

```typescript
import { extractFromTranscript, extractWithRegex } from './extract.js';

async function handleExtract(config: any, projectPath: string, transcriptPath: string) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    console.error('Usage: memento extract <transcript-path>');
    process.exit(1);
  }

  const transcript = fs.readFileSync(transcriptPath, 'utf-8');
  let extracted;

  try {
    extracted = await extractFromTranscript(
      transcript,
      config.ollama.host,
      config.extraction?.ollama?.model ?? config.ollama.generativeModel,
    );
    console.log(`Extracted ${extracted.length} memories via LLM.`);
  } catch {
    console.log('LLM extraction failed, falling back to regex.');
    extracted = extractWithRegex(transcript);
    console.log(`Extracted ${extracted.length} memories via regex.`);
  }

  if (extracted.length === 0) {
    console.log('No memories extracted.');
    return;
  }

  // Store via the same pipeline as remember tool
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const embeddings = new OllamaEmbeddings({
    host: config.ollama.host,
    model: config.ollama.embeddingModel,
  });

  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'extract';
  const projectId = getProjectId(projectPath);

  for (const mem of extracted) {
    const embedding = await embeddings.generate(mem.content);
    const memory = {
      id: nanoid(),
      timestamp: Date.now(),
      project: projectId,
      scope: 'project' as const,
      type: mem.type,
      content: mem.content,
      tags: [],
      embedding,
      sessionId,
      isCore: false,
      recallCount: 0,
      lastRecalled: 0,
    };
    await storage.store(memory);
  }

  console.log(`Stored ${extracted.length} memories.`);
  await storage.disconnect();
}
```

Add missing imports at top of `cli.ts`:

```typescript
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { getProjectId } from './config.js';
```

**Step 3: Rewrite session-end hook**

Replace `hooks/session-end.sh`:

```bash
#!/bin/bash
# hooks/session-end.sh
# Fires on SessionEnd — autonomous extraction via Ollama, regex fallback

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Extract memories from transcript if available
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  $CLI extract "$TRANSCRIPT_PATH" 2>/dev/null || true
fi

# Update stats
STATS=$($CLI stats 2>/dev/null || true)
TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")

if [ -f "$HOME/.memento-stats" ]; then
  PREV_RECALLED=$(grep -o '"recalled":[0-9]*' "$HOME/.memento-stats" | cut -d: -f2)
else
  PREV_RECALLED=0
fi
echo "{\"total\":$TOTAL,\"recalled\":${PREV_RECALLED:-0},\"updated\":$(date +%s)}" > "$HOME/.memento-stats"

exit 0
```

**Step 4: Build**

Run: `npx tsc`
Expected: BUILD SUCCESS

**Step 5: Commit**

```bash
git add src/extract.ts src/cli.ts hooks/session-end.sh
git commit -m "feat: session-end autonomous extraction with Ollama + regex fallback"
```

---

## Phase 8: Makefile + Docker

### Task 14: Update Makefile and docker-compose

**Files:**
- Modify: `Makefile`
- Modify: `docker-compose.yml`

**Step 1: Add hydrate to Makefile**

Add after the `start` target:

```makefile
start: ## Start infrastructure (Redis + Ollama)
	@$(COMPOSE) up -d
	@make status
	@echo "Hydrating Redis..."
	@$(CLI) hydrate 2>/dev/null || echo "Hydrate skipped (build first)"
```

Add new target:

```makefile
hydrate: ## Hydrate Redis from SQLite
	@$(CLI) hydrate

core: ## Show core memories
	@$(CLI) core
```

Update `.PHONY` line to include new targets:

```makefile
.PHONY: help setup start stop status build dev test clean recall stats flush hydrate core
```

**Step 2: Update docker-compose to pull generative model**

Add an init service to `docker-compose.yml` that pulls qwen2.5:3b after ollama starts:

```yaml
  ollama-init:
    image: ollama/ollama:latest
    depends_on:
      ollama:
        condition: service_healthy
    restart: "no"
    entrypoint: ["ollama", "pull", "qwen2.5:3b"]
    environment:
      - OLLAMA_HOST=http://ollama:11434
```

**Step 3: Build and verify**

Run: `npx tsc`
Expected: BUILD SUCCESS

**Step 4: Commit**

```bash
git add Makefile docker-compose.yml
git commit -m "feat: add hydrate to start, pull generative model on init"
```

---

## Phase 9: Final verification

### Task 15: Run full test suite and manual smoke test

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Build clean**

Run: `make clean && make build`
Expected: BUILD SUCCESS

**Step 3: Manual smoke test**

```bash
# Start services
make start

# Check stats
make stats

# Store a test memory via CLI recall (should work after hydrate)
make recall ARGS="test query"

# Check core memories
make core
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: memento v0.2 complete — RRF search, core memory, compact format, autonomous hooks"
```

---

## Task dependency graph

```
Task 1 (types + config)
  ├── Task 2 (SQLite) ──┐
  ├── Task 3 (Redis)  ──┼── Task 4 (SyncStorage)
  │                      │     ├── Task 5 (RRF search)
  │                      │     ├── Task 6 (Reranker)
  │                      │     ├── Task 7 (recall tool)
  │                      │     └── Task 8 (remember tool)
  │                      │           └── Task 9 (server.ts wiring)
  │                      │                 ├── Task 10 (CLI)
  │                      │                 ├── Task 11 (session-start hook)
  │                      │                 ├── Task 12 (pre-compact hook)
  │                      │                 └── Task 13 (session-end + extract)
  │                      │                       └── Task 14 (Makefile + Docker)
  │                      │                             └── Task 15 (verification)
```

Parallelizable: Tasks 2+3, Tasks 5+6, Tasks 7+8, Tasks 11+12
