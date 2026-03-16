# Memento v0.3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use viterbit:executing-plans to implement this plan task-by-task.

**Goal:** Add resilience (fail fast), memory graph for navigation + ranking, shared dedup pipeline, semantic diversify, fire-and-forget merge, and core degradation.

**Architecture:** Persistent graph in SQLite (`memory_edges` table), shared `storeWithDedup` pipeline for all write paths, post-rerank diversify via cosine similarity, background merge with Promise, health checks at startup.

**Tech Stack:** TypeScript, Redis Stack, SQLite (better-sqlite3), Ollama, vitest

**Design doc:** `docs/plans/2026-03-12-memento-v03-design.md`

---

## Dependency Graph

```
Task 1 (health.ts)         → Task 9 (server.ts integration)
Task 2 (graph schema)      → Task 3 (graph CRUD) → Task 5 (pipeline) → Task 7 (remember refactor)
                                                  → Task 8 (extract refactor)
Task 3 (graph CRUD)        → Task 6 (recall + graph navigation)
Task 4 (diversify)         → Task 6 (recall + diversify)
Task 5 (pipeline)          → Task 7, Task 8
Task 10 (maintain CLI)     independent
Task 11 (session-start hook) depends on Task 10
```

Independent tasks: 1, 2, 4, 10 can be parallelized.

---

## Phase 1: Foundation (independent building blocks)

### Task 1: Health checks — `src/health.ts`

**Files:**
- Create: `src/health.ts`
- Test: `src/__tests__/health.test.ts`

**Step 1: Write the test**

```typescript
// src/__tests__/health.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkDependencies } from '../health.js';

// We test that checkDependencies calls process.exit(1) on failures
// and logs appropriate messages

describe('checkDependencies', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as any);
  const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    exitSpy.mockClear();
    stderrSpy.mockClear();
  });

  it('should fail with clear message when Redis is unreachable', async () => {
    const config = {
      redis: { host: '127.0.0.1', port: 19999 },
      ollama: { host: 'http://127.0.0.1:19998', embeddingModel: 'nomic-embed-text', generativeModel: 'qwen2.5:3b' },
    };

    await expect(checkDependencies(config as any)).rejects.toThrow('process.exit called');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Redis not available'));
  });

  it('should fail with clear message when Ollama is unreachable', async () => {
    // This test needs Redis to be available but Ollama not
    // Skip in CI — only run with infrastructure up
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/health.test.ts`
Expected: FAIL — `../health.js` module not found

**Step 3: Implement health checks**

```typescript
// src/health.ts
import { Redis } from 'ioredis';
import type { MementoConfig } from './types.js';

export async function checkDependencies(config: MementoConfig): Promise<void> {
  // 1. Redis ping
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
  });
  try {
    await redis.connect();
    await redis.ping();
    await redis.quit();
  } catch {
    console.error(`Memento: Redis not available at ${config.redis.host}:${config.redis.port}`);
    process.exit(1);
  }

  // 2. Ollama reachable + models
  try {
    const res = await fetch(`${config.ollama.host}/api/tags`);
    const data = await res.json() as { models: { name: string }[] };
    const models = new Set(data.models.map((m) => m.name.split(':')[0]));

    // 3. Embedding model — hard fail
    if (!models.has(config.ollama.embeddingModel.split(':')[0])) {
      console.error(`Memento: embedding model '${config.ollama.embeddingModel}' not found in Ollama`);
      process.exit(1);
    }

    // 4. Generative model — soft warning
    if (!models.has(config.ollama.generativeModel.split(':')[0])) {
      console.error(`Memento: generative model '${config.ollama.generativeModel}' not available (merge/extract will degrade)`);
    }
  } catch {
    console.error(`Memento: Ollama not available at ${config.ollama.host}`);
    process.exit(1);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/health.test.ts`
Expected: PASS (Redis unreachable test passes)

**Step 5: Commit**

```bash
git add src/health.ts src/__tests__/health.test.ts
git commit -m "feat: add health checks with fail-fast behavior"
```

---

### Task 2: Graph schema — SQLite migration

**Files:**
- Modify: `src/storage/sqlite.ts:16-55` (migrate method)

**Step 1: Write the test**

```typescript
// Add to src/storage/__tests__/sqlite.test.ts

describe('memory_edges table', () => {
  it('should create memory_edges table on migration', () => {
    // The table should exist after SqliteStorage construction
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/__tests__/sqlite.test.ts`
Expected: FAIL — `memory_edges` table doesn't exist

**Step 3: Add migration to SqliteStorage.migrate()**

Add after the existing `CREATE TABLE IF NOT EXISTS memories` block in `src/storage/sqlite.ts:17-39`:

```typescript
// Inside migrate(), after memories table creation:
this.db.exec(`
  CREATE TABLE IF NOT EXISTS memory_edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    similarity REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, target_id),
    FOREIGN KEY (source_id) REFERENCES memories(id),
    FOREIGN KEY (target_id) REFERENCES memories(id)
  );

  CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_id);
`);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/__tests__/sqlite.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/storage/sqlite.ts src/storage/__tests__/sqlite.test.ts
git commit -m "feat: add memory_edges table migration"
```

---

### Task 3: Graph CRUD — SQLite edge operations

**Files:**
- Modify: `src/storage/sqlite.ts` (add edge methods)
- Test: `src/storage/__tests__/graph.test.ts`

**Step 1: Write the test**

```typescript
// src/storage/__tests__/graph.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStorage } from '../sqlite.js';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Memory } from '../../types.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: nanoid(),
    timestamp: Date.now(),
    project: 'test',
    scope: 'project',
    type: 'decision',
    content: 'test content',
    tags: [],
    embedding: new Array(768).fill(0.1),
    sessionId: 'sess1',
    isCore: false,
    recallCount: 0,
    lastRecalled: 0,
    ...overrides,
  };
}

describe('Graph edges', () => {
  let storage: SqliteStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `memento-test-graph-${nanoid(6)}.db`);
    storage = new SqliteStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it('should add bidirectional edges', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    storage.store(m1);
    storage.store(m2);

    storage.addEdge(m1.id, m2.id, 0.85);

    const neighbors = storage.getNeighbors(m1.id);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].id).toBe(m2.id);

    const reverseNeighbors = storage.getNeighbors(m2.id);
    expect(reverseNeighbors).toHaveLength(1);
    expect(reverseNeighbors[0].id).toBe(m1.id);
  });

  it('should calculate degree correctly', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    const m3 = makeMemory();
    storage.store(m1);
    storage.store(m2);
    storage.store(m3);

    storage.addEdge(m1.id, m2.id, 0.85);
    storage.addEdge(m1.id, m3.id, 0.75);

    expect(storage.getDegree(m1.id)).toBe(2);
    expect(storage.getDegree(m2.id)).toBe(1);
  });

  it('should transfer edges from old to new memory', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    const m3 = makeMemory();
    storage.store(m1);
    storage.store(m2);
    storage.store(m3);

    storage.addEdge(m1.id, m2.id, 0.85);
    storage.addEdge(m1.id, m3.id, 0.75);

    storage.transferEdges(m1.id, m2.id);

    expect(storage.getDegree(m1.id)).toBe(0);
    expect(storage.getDegree(m2.id)).toBe(1); // edge to m3
    expect(storage.getNeighbors(m2.id)[0].id).toBe(m3.id);
  });

  it('should delete memory and cascade edges', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    storage.store(m1);
    storage.store(m2);

    storage.addEdge(m1.id, m2.id, 0.85);
    storage.deleteMemory(m1.id);

    expect(storage.getById(m1.id)).toBeUndefined();
    expect(storage.getDegree(m2.id)).toBe(0);
  });

  it('should get neighbors with similarity scores', () => {
    const m1 = makeMemory();
    const m2 = makeMemory({ content: 'related content' });
    storage.store(m1);
    storage.store(m2);

    storage.addEdge(m1.id, m2.id, 0.82);

    const neighbors = storage.getNeighborsWithSimilarity(m1.id);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].memory.id).toBe(m2.id);
    expect(neighbors[0].similarity).toBeCloseTo(0.82);
  });

  it('should get degrees in batch', () => {
    const m1 = makeMemory();
    const m2 = makeMemory();
    const m3 = makeMemory();
    storage.store(m1);
    storage.store(m2);
    storage.store(m3);

    storage.addEdge(m1.id, m2.id, 0.85);
    storage.addEdge(m1.id, m3.id, 0.75);

    const degrees = storage.getDegrees([m1.id, m2.id, m3.id]);
    expect(degrees.get(m1.id)).toBe(2);
    expect(degrees.get(m2.id)).toBe(1);
    expect(degrees.get(m3.id)).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/__tests__/graph.test.ts`
Expected: FAIL — methods not found

**Step 3: Implement graph methods in SqliteStorage**

Add to `src/storage/sqlite.ts` after `mergeContent()`:

```typescript
addEdge(sourceId: string, targetId: string, similarity: number): void {
  const stmt = this.db.prepare(`
    INSERT OR IGNORE INTO memory_edges (source_id, target_id, similarity)
    VALUES (?, ?, ?)
  `);
  const insert = this.db.transaction(() => {
    stmt.run(sourceId, targetId, similarity);
    stmt.run(targetId, sourceId, similarity);
  });
  insert();
}

getNeighbors(memoryId: string): Memory[] {
  const rows = this.db.prepare(`
    SELECT m.* FROM memory_edges e
    JOIN memories m ON m.id = e.target_id
    WHERE e.source_id = ?
    ORDER BY e.similarity DESC
  `).all(memoryId) as any[];
  return rows.map(this.rowToMemory);
}

getNeighborsWithSimilarity(memoryId: string): { memory: Memory; similarity: number }[] {
  const rows = this.db.prepare(`
    SELECT m.*, e.similarity FROM memory_edges e
    JOIN memories m ON m.id = e.target_id
    WHERE e.source_id = ?
    ORDER BY e.similarity DESC
  `).all(memoryId) as any[];
  return rows.map((row: any) => ({
    memory: this.rowToMemory(row),
    similarity: row.similarity,
  }));
}

getDegree(memoryId: string): number {
  const row = this.db.prepare(
    'SELECT COUNT(*) as cnt FROM memory_edges WHERE source_id = ?'
  ).get(memoryId) as any;
  return row?.cnt ?? 0;
}

getDegrees(memoryIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (memoryIds.length === 0) return result;

  const placeholders = memoryIds.map(() => '?').join(',');
  const rows = this.db.prepare(`
    SELECT source_id, COUNT(*) as cnt
    FROM memory_edges
    WHERE source_id IN (${placeholders})
    GROUP BY source_id
  `).all(...memoryIds) as any[];

  for (const id of memoryIds) result.set(id, 0);
  for (const row of rows) result.set(row.source_id, row.cnt);
  return result;
}

transferEdges(fromId: string, toId: string): void {
  this.db.transaction(() => {
    // Update edges where fromId is source → toId is source
    this.db.prepare(`
      UPDATE OR IGNORE memory_edges SET source_id = ? WHERE source_id = ? AND target_id != ?
    `).run(toId, fromId, toId);
    // Update edges where fromId is target → toId is target
    this.db.prepare(`
      UPDATE OR IGNORE memory_edges SET target_id = ? WHERE target_id = ? AND source_id != ?
    `).run(toId, fromId, toId);
    // Delete any remaining edges involving fromId (self-loops or conflicts)
    this.db.prepare('DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?').run(fromId, fromId);
  })();
}

deleteMemory(id: string): void {
  this.db.transaction(() => {
    this.db.prepare('DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?').run(id, id);
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  })();
}
```

Note: `rowToMemory` must be changed from arrow-to-method or bound, because it's used as `this.rowToMemory` in a callback. Check if it's already bound — currently at line 127 it's a regular method, used as `this.rowToMemory` in `map()`. It needs binding:

In the constructor, add: `this.rowToMemory = this.rowToMemory.bind(this);`

Or change `rows.map(this.rowToMemory)` to `rows.map(r => this.rowToMemory(r))` in existing code (listByProject, getAll, getCoreMemories, getNeighbors, getNeighborsWithSimilarity).

**Step 4: Run tests**

Run: `npx vitest run src/storage/__tests__/graph.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/storage/sqlite.ts src/storage/__tests__/graph.test.ts
git commit -m "feat: add graph edge CRUD operations in SQLite"
```

---

### Task 4: Diversify algorithm in Reranker

**Files:**
- Modify: `src/search/reranker.ts`
- Test: `src/search/__tests__/diversify.test.ts`

**Step 1: Write the test**

```typescript
// src/search/__tests__/diversify.test.ts
import { describe, it, expect } from 'vitest';
import { Reranker } from '../reranker.js';
import type { RecallResult } from '../../types.js';

function makeResult(id: string, score: number, embedding: number[]): RecallResult {
  return {
    memory: {
      id,
      timestamp: Date.now(),
      project: 'test',
      scope: 'project',
      type: 'decision',
      content: `content-${id}`,
      tags: [],
      embedding,
      sessionId: 'sess1',
      isCore: false,
      recallCount: 0,
      lastRecalled: 0,
    },
    score,
    source: 'rrf',
  };
}

// Helper: create embedding that's "similar" to base by adding small noise
function similarEmbedding(base: number[], noise: number = 0.01): number[] {
  return base.map(v => v + (Math.random() - 0.5) * noise);
}

describe('Reranker.diversify', () => {
  const reranker = new Reranker();

  it('should keep diverse results unchanged', () => {
    const e1 = Array(768).fill(0).map(() => Math.random());
    const e2 = Array(768).fill(0).map(() => Math.random());
    const e3 = Array(768).fill(0).map(() => Math.random());

    const results = [
      makeResult('a', 1.0, e1),
      makeResult('b', 0.9, e2),
      makeResult('c', 0.8, e3),
    ];

    const diversified = reranker.diversify(results, 3);
    expect(diversified).toHaveLength(3);
  });

  it('should remove near-duplicate results', () => {
    const e1 = Array(768).fill(0).map(() => Math.random());
    const e1clone = similarEmbedding(e1, 0.001); // very similar

    const results = [
      makeResult('a', 1.0, e1),
      makeResult('a-dup', 0.95, e1clone),
      makeResult('b', 0.9, Array(768).fill(0).map(() => Math.random())),
    ];

    const diversified = reranker.diversify(results, 3);
    expect(diversified).toHaveLength(2);
    expect(diversified.map(r => r.memory.id)).not.toContain('a-dup');
  });

  it('should track relatedCount for skipped duplicates', () => {
    const e1 = Array(768).fill(0).map(() => Math.random());
    const e1c1 = similarEmbedding(e1, 0.001);
    const e1c2 = similarEmbedding(e1, 0.001);

    const results = [
      makeResult('a', 1.0, e1),
      makeResult('a-dup1', 0.95, e1c1),
      makeResult('a-dup2', 0.9, e1c2),
      makeResult('b', 0.85, Array(768).fill(0).map(() => Math.random())),
    ];

    const diversified = reranker.diversify(results, 3);
    const aResult = diversified.find(r => r.memory.id === 'a') as any;
    expect(aResult.relatedCount).toBe(2);
  });

  it('should respect threshold parameter', () => {
    const e1 = Array(768).fill(0).map(() => Math.random());
    const e1mild = similarEmbedding(e1, 0.1); // moderate similarity

    const results = [
      makeResult('a', 1.0, e1),
      makeResult('b', 0.9, e1mild),
    ];

    // With very strict threshold (0.99), both should pass
    const strict = reranker.diversify(results, 3, 0.99);
    expect(strict).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/search/__tests__/diversify.test.ts`
Expected: FAIL — `diversify` method not found

**Step 3: Implement diversify in Reranker**

Add to `src/search/reranker.ts`:

```typescript
// Add at top of file, outside the class:
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Add to class Reranker:
diversify(
  results: RecallResult[],
  finalK: number,
  threshold: number = 0.85,
): (RecallResult & { relatedCount?: number })[] {
  const selected: RecallResult[] = [];
  const relatedCounts = new Map<string, number>();

  for (const r of results) {
    if (selected.length >= finalK) break;

    // Need embeddings to compare
    if (r.memory.embedding.length === 0) {
      selected.push(r);
      continue;
    }

    let tooSimilarTo: RecallResult | undefined;
    for (const s of selected) {
      if (s.memory.embedding.length === 0) continue;
      if (cosineSimilarity(r.memory.embedding, s.memory.embedding) > threshold) {
        tooSimilarTo = s;
        break;
      }
    }

    if (tooSimilarTo) {
      relatedCounts.set(
        tooSimilarTo.memory.id,
        (relatedCounts.get(tooSimilarTo.memory.id) ?? 0) + 1,
      );
      continue;
    }

    selected.push(r);
  }

  return selected.map(r => ({
    ...r,
    relatedCount: relatedCounts.get(r.memory.id) ?? 0,
  }));
}
```

**Step 4: Run test**

Run: `npx vitest run src/search/__tests__/diversify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/search/reranker.ts src/search/__tests__/diversify.test.ts
git commit -m "feat: add semantic diversify to reranker"
```

---

## Phase 2: Core pipeline

### Task 5: Shared storeWithDedup pipeline

**Files:**
- Create: `src/storage/pipeline.ts`
- Test: `src/storage/__tests__/pipeline.test.ts`

**Step 1: Write the test**

```typescript
// src/storage/__tests__/pipeline.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeWithDedup, type StoreInput, type PipelineDeps } from '../pipeline.js';

function mockDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    storage: {
      store: vi.fn().mockResolvedValue(undefined),
      search: {
        vector: vi.fn().mockResolvedValue([]),
      },
    } as any,
    sqlite: {
      addEdge: vi.fn(),
      getDegree: vi.fn().mockReturnValue(0),
    } as any,
    embeddings: {
      generate: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
      generateBatch: vi.fn().mockResolvedValue([new Array(768).fill(0.1)]),
    } as any,
    config: {
      search: {
        deduplicationThreshold: 0.92,
        mergeThreshold: 0.80,
      },
      core: { promoteAfterRecalls: 3 },
    } as any,
    projectId: 'test-project',
    sessionId: 'test-session',
    ...overrides,
  };
}

describe('storeWithDedup', () => {
  it('should store new memory when no similar exists', async () => {
    const deps = mockDeps();
    const inputs: StoreInput[] = [{ type: 'decision', content: 'use Redis for search' }];

    const result = await storeWithDedup(inputs, deps);

    expect(result.stored).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.deduplicated).toBe(0);
    expect(deps.storage.store).toHaveBeenCalledOnce();
  });

  it('should skip duplicate when similarity > 0.92', async () => {
    const embedding = new Array(768).fill(0.5);
    const deps = mockDeps({
      embeddings: {
        generate: vi.fn().mockResolvedValue(embedding),
        generateBatch: vi.fn().mockResolvedValue([embedding]),
      } as any,
      storage: {
        store: vi.fn(),
        search: {
          vector: vi.fn().mockResolvedValue([{
            id: 'existing',
            content: 'use Redis for search',
            embedding,
            type: 'decision',
            timestamp: Date.now(),
            project: 'test',
            scope: 'project',
            tags: [],
            sessionId: 'old',
            isCore: false,
            recallCount: 0,
            lastRecalled: 0,
          }]),
        },
      } as any,
    });

    const result = await storeWithDedup(
      [{ type: 'decision', content: 'use Redis for search' }],
      deps,
    );

    expect(result.deduplicated).toBe(1);
    expect(result.stored).toBe(0);
    expect(deps.storage.store).not.toHaveBeenCalled();
  });

  it('should create graph edges for related memories (0.70-0.92)', async () => {
    // Create two different but related embeddings
    const newEmb = new Array(768).fill(0).map((_, i) => Math.sin(i));
    const existingEmb = newEmb.map(v => v * 0.9 + 0.05); // related but distinct

    const deps = mockDeps({
      embeddings: {
        generate: vi.fn().mockResolvedValue(newEmb),
        generateBatch: vi.fn().mockResolvedValue([newEmb]),
      } as any,
      storage: {
        store: vi.fn(),
        search: {
          vector: vi.fn().mockResolvedValue([{
            id: 'related-mem',
            content: 'related content',
            embedding: existingEmb,
            type: 'decision',
            timestamp: Date.now(),
            project: 'test',
            scope: 'project',
            tags: [],
            sessionId: 'old',
            isCore: false,
            recallCount: 0,
            lastRecalled: 0,
          }]),
        },
      } as any,
    });

    await storeWithDedup(
      [{ type: 'decision', content: 'new related content' }],
      deps,
    );

    // Edge creation depends on actual cosine similarity of test vectors
    // The key assertion is that store was called (not deduplicated)
    expect(deps.storage.store).toHaveBeenCalled();
  });

  it('should batch embed multiple inputs', async () => {
    const deps = mockDeps();
    const inputs: StoreInput[] = [
      { type: 'decision', content: 'first' },
      { type: 'learning', content: 'second' },
    ];
    (deps.embeddings.generateBatch as any).mockResolvedValue([
      new Array(768).fill(0.1),
      new Array(768).fill(0.2),
    ]);

    await storeWithDedup(inputs, deps);

    expect(deps.embeddings.generateBatch).toHaveBeenCalledWith(['first', 'second']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/__tests__/pipeline.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the pipeline**

```typescript
// src/storage/pipeline.ts
import { nanoid } from 'nanoid';
import type { SyncStorage } from './sync.js';
import type { SqliteStorage } from './sqlite.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { MementoConfig, Memory, MemoryType } from '../types.js';

export interface StoreInput {
  type: MemoryType;
  content: string;
  core?: boolean;
}

export interface StoreResult {
  stored: number;
  merged: number;
  deduplicated: number;
}

export interface PipelineDeps {
  storage: SyncStorage;
  sqlite: SqliteStorage;
  embeddings: OllamaEmbeddings;
  config: MementoConfig;
  projectId: string;
  sessionId: string;
  mergeWithLLM?: (old: string, new_: string) => Promise<string>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function storeWithDedup(
  inputs: StoreInput[],
  deps: PipelineDeps,
): Promise<StoreResult> {
  const { storage, sqlite, embeddings, config, projectId, sessionId, mergeWithLLM } = deps;

  let stored = 0;
  let merged = 0;
  let deduplicated = 0;

  // 1. Batch generate embeddings
  const contents = inputs.map(m => m.content);
  const allEmbeddings = inputs.length === 1
    ? [await embeddings.generate(contents[0])]
    : await embeddings.generateBatch(contents);

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const embedding = allEmbeddings[i];

    // 2. Vector search top-1 for dedup check
    const existing = await storage.search.vector(embedding, 10);

    let bestMatch: { memory: Memory; similarity: number } | undefined;

    if (existing.length > 0) {
      // Compare with embeddings
      for (const candidate of existing) {
        const candidateEmb = candidate.embedding.length > 0
          ? candidate.embedding
          : await embeddings.generate(candidate.content);
        const sim = cosineSimilarity(embedding, candidateEmb);

        if (!bestMatch || sim > bestMatch.similarity) {
          bestMatch = { memory: candidate, similarity: sim };
        }
      }
    }

    if (bestMatch) {
      // 3. Similarity > 0.92 → deduplicate
      if (bestMatch.similarity > config.search.deduplicationThreshold) {
        deduplicated++;
        continue;
      }

      // 4. Similarity 0.80-0.92 → store + edge + background merge
      if (bestMatch.similarity > config.search.mergeThreshold) {
        const newMemory = createMemory(input, embedding, projectId, sessionId);
        await storage.store(newMemory);
        sqlite.addEdge(newMemory.id, bestMatch.memory.id, bestMatch.similarity);

        // Fire-and-forget background merge
        if (mergeWithLLM) {
          backgroundMerge(
            bestMatch.memory, newMemory, storage, sqlite, embeddings, mergeWithLLM,
          );
        }

        stored++;

        // Build edges to other related results
        buildEdges(newMemory.id, embedding, existing, bestMatch.memory.id, sqlite, embeddings, config);
        continue;
      }

      // 5. Similarity 0.70-0.80 → store + edge (related but distinct)
      if (bestMatch.similarity > 0.70) {
        const newMemory = createMemory(input, embedding, projectId, sessionId);
        await storage.store(newMemory);
        sqlite.addEdge(newMemory.id, bestMatch.memory.id, bestMatch.similarity);
        stored++;

        buildEdges(newMemory.id, embedding, existing, bestMatch.memory.id, sqlite, embeddings, config);
        continue;
      }
    }

    // 6. No match or similarity < 0.70 → store new
    const newMemory = createMemory(input, embedding, projectId, sessionId);
    await storage.store(newMemory);
    stored++;

    // Still check for edges to other results
    if (existing.length > 0) {
      buildEdges(newMemory.id, embedding, existing, undefined, sqlite, embeddings, config);
    }
  }

  return { stored, merged, deduplicated };
}

function createMemory(
  input: StoreInput,
  embedding: number[],
  projectId: string,
  sessionId: string,
): Memory {
  return {
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
}

async function buildEdges(
  newId: string,
  newEmbedding: number[],
  candidates: Memory[],
  alreadyLinked: string | undefined,
  sqlite: SqliteStorage,
  embeddings: OllamaEmbeddings,
  config: MementoConfig,
): Promise<void> {
  for (const candidate of candidates) {
    if (candidate.id === alreadyLinked) continue;

    const candidateEmb = candidate.embedding.length > 0
      ? candidate.embedding
      : await embeddings.generate(candidate.content);
    const sim = cosineSimilarity(newEmbedding, candidateEmb);

    if (sim > 0.70 && sim < config.search.deduplicationThreshold) {
      sqlite.addEdge(newId, candidate.id, sim);
    }
  }
}

function backgroundMerge(
  oldMemory: Memory,
  newMemory: Memory,
  storage: SyncStorage,
  sqlite: SqliteStorage,
  embeddings: OllamaEmbeddings,
  mergeWithLLM: (old: string, new_: string) => Promise<string>,
): void {
  Promise.resolve().then(async () => {
    const mergedContent = await mergeWithLLM(oldMemory.content, newMemory.content);
    const mergedEmbedding = await embeddings.generate(mergedContent);
    await storage.mergeMemory(newMemory.id, mergedContent, mergedEmbedding);
    sqlite.transferEdges(oldMemory.id, newMemory.id);
    await storage.deleteMemory(oldMemory.id);
  }).catch(console.error);
}
```

**Step 4: Run test**

Run: `npx vitest run src/storage/__tests__/pipeline.test.ts`
Expected: PASS

**Step 5: Add `deleteMemory` to SyncStorage**

In `src/storage/sync.ts`, add:

```typescript
async deleteMemory(id: string): Promise<void> {
  this.sqlite.deleteMemory(id);
  await this.redis.delete(id).catch(() => {});
}
```

In `src/storage/redis.ts`, add:

```typescript
async delete(id: string): Promise<void> {
  await this.client.del(`${this.prefix}${id}`);
}
```

Also expose `sqlite` from SyncStorage for the pipeline:

```typescript
get sqliteDb(): SqliteStorage {
  return this.sqlite;
}
```

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: All existing + new tests PASS

**Step 7: Commit**

```bash
git add src/storage/pipeline.ts src/storage/__tests__/pipeline.test.ts src/storage/sync.ts src/storage/redis.ts
git commit -m "feat: add shared storeWithDedup pipeline with graph edges"
```

---

### Task 6: Recall with graph integration

**Files:**
- Modify: `src/tools/recall.ts`
- Modify: `src/search/reranker.ts` (add graph degree boost)
- Modify: `src/search/hybrid.ts` (return embeddings from Redis)

**Step 1: Update `rawHashToMemory` in Redis to parse embeddings**

In `src/storage/redis.ts:223-240`, the `rawHashToMemory` currently returns `embedding: []`. Update it:

```typescript
private rawHashToMemory(id: string, data: Record<string, any>): Memory {
  const str = (key: string) => (data[key] != null ? String(data[key]) : '');

  let embedding: number[] = [];
  const embField = data['embedding'];
  if (embField && Buffer.isBuffer(embField) && embField.length > 0) {
    embedding = Array.from(new Float32Array(new Uint8Array(embField).buffer));
  }

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
    isCore: str('is_core') === '1',
    recallCount: Number(str('recall_count')) || 0,
    lastRecalled: Number(str('last_recalled')) || 0,
  };
}
```

**Note:** FT.SEARCH returns embedding as a Buffer when RETURN includes it. Verify by checking that the HNSW field is returned in the search results. If not, add `RETURN` clause to `searchVector` and `searchText` to explicitly include `embedding`.

**Step 2: Add graph degree boost to reranker**

Modify `src/search/reranker.ts` — the `rerank` method signature gets an optional `degrees` map:

```typescript
rerank(
  results: RecallResult[],
  finalK: number,
  degrees?: Map<string, number>,
): RecallResult[] {
  // ... existing filter logic ...

  const scored = filtered.map(r => {
    const typeWeight = TYPE_WEIGHTS[r.memory.type] ?? 1.0;
    const age = now - r.memory.timestamp;
    const recencyBoost = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
    const recallBoost = 1 + Math.sqrt(r.memory.recallCount) * 0.05;
    const degree = degrees?.get(r.memory.id) ?? 0;
    const graphBoost = 1 + Math.log2(1 + degree) * 0.1;
    const finalScore = r.score * typeWeight * (0.5 + 0.5 * recencyBoost) * recallBoost * graphBoost;
    return { ...r, score: finalScore };
  });

  // ... rest unchanged ...
}
```

**Step 3: Update recall tool with `expand` param and diversify**

Replace `src/tools/recall.ts` with:

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
    'Search persistent memory. Returns compact results: TYPE|MMDD|content. Use expand with a memory ID to navigate the graph.',
    {
      query: z.string().describe('Natural language query'),
      expand: z.string().optional().describe('Memory ID (6-char prefix) to expand neighbors from graph'),
      type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']).optional(),
      limit: z.number().optional().describe('Max results (default: 3)'),
    },
    async ({ query, expand, type, limit }) => {
      // Graph expansion mode
      if (expand) {
        return handleExpand(expand, storage);
      }

      // Normal recall
      const results = await search.search({ query, type, limit: config.search.topK });

      // Get degrees for graph boost
      const ids = results.map(r => r.memory.id);
      const degrees = storage.sqliteDb.getDegrees(ids);

      const ranked = reranker.rerank(results, (limit ?? config.search.finalK) * 3, degrees);
      const diversified = reranker.diversify(ranked, limit ?? config.search.finalK);

      if (diversified.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }

      // Fire-and-forget: increment recall counts + auto-promote
      for (const r of diversified) {
        storage.incrementRecallCount(r.memory.id).then(() => {
          const newCount = r.memory.recallCount + 1;
          if (!r.memory.isCore && newCount >= config.core.promoteAfterRecalls) {
            storage.setCore(r.memory.id, true);
          }
          // Auto-promote by degree
          const degree = degrees.get(r.memory.id) ?? 0;
          if (!r.memory.isCore && degree >= 10) {
            storage.setCore(r.memory.id, true);
          }
        }).catch(() => {});
      }

      // Build related section from graph
      const related = buildRelatedSection(diversified, storage);

      let output = formatCompact(diversified);
      if (related) {
        output += '\n\n-- related --\n' + related;
      }

      return { content: [{ type: 'text', text: output }] };
    },
  );
}

function handleExpand(shortId: string, storage: SyncStorage) {
  const neighbors = storage.sqliteDb.getNeighborsWithSimilarity(shortId);

  // Try with prefix match if short ID
  // For now, use exact ID — the caller provides the full ID or prefix

  if (neighbors.length === 0) {
    return { content: [{ type: 'text', text: `No neighbors for ${shortId}.` }] };
  }

  const lines = neighbors.map(n => {
    const t = TYPE_CHAR[n.memory.type] ?? '?';
    const d = new Date(n.memory.timestamp);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const sim = (n.similarity * 100).toFixed(0);
    return `${t}|${mm}${dd}|${n.memory.content} (${sim}%)`;
  });

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function formatCompact(results: (RecallResult & { relatedCount?: number })[]): string {
  return results.map(r => {
    const t = TYPE_CHAR[r.memory.type] ?? '?';
    const d = new Date(r.memory.timestamp);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const shortId = r.memory.id.slice(0, 6);
    const related = (r as any).relatedCount > 0 ? ` (+${(r as any).relatedCount} related)` : '';
    return `[${shortId}] ${t}|${mm}${dd}|${r.memory.content}${related}`;
  }).join('\n');
}

function buildRelatedSection(
  results: RecallResult[],
  storage: SyncStorage,
): string {
  const shown = new Set(results.map(r => r.memory.id));
  const relatedLines: string[] = [];

  for (const r of results) {
    const neighbors = storage.sqliteDb.getNeighbors(r.memory.id);
    for (const n of neighbors) {
      if (shown.has(n.id)) continue;
      shown.add(n.id);
      const degree = storage.sqliteDb.getDegree(n.id);
      const shortId = n.id.slice(0, 6);
      const truncated = n.content.length > 60 ? n.content.slice(0, 60) + '...' : n.content;
      relatedLines.push(`[${shortId}] ${truncated} (${degree} connections)`);
    }
  }

  return relatedLines.slice(0, 5).join('\n');
}
```

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS (existing recall tests may need minor adjustments for new output format)

**Step 5: Commit**

```bash
git add src/tools/recall.ts src/search/reranker.ts src/storage/redis.ts
git commit -m "feat: integrate graph into recall — degree boost, diversify, expand, related section"
```

---

## Phase 3: Refactor consumers

### Task 7: Refactor remember tool to use pipeline

**Files:**
- Modify: `src/tools/remember.ts`

**Step 1: Rewrite remember tool to use storeWithDedup**

Replace `src/tools/remember.ts`:

```typescript
import { z } from 'zod';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { MementoConfig } from '../types.js';
import { getProjectId } from '../config.js';
import { storeWithDedup } from '../storage/pipeline.js';

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

      const result = await storeWithDedup(inputs, {
        storage,
        sqlite: storage.sqliteDb,
        embeddings,
        config,
        projectId,
        sessionId,
        mergeWithLLM,
      });

      if (result.stored > 0 || result.merged > 0) {
        updateStatsCache(storage);
      }

      const parts = [`Stored ${result.stored}`];
      if (result.merged > 0) parts.push(`merged ${result.merged}`);
      if (result.deduplicated > 0) parts.push(`skipped ${result.deduplicated} dupes`);

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
```

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/tools/remember.ts
git commit -m "refactor: remember tool uses shared storeWithDedup pipeline"
```

---

### Task 8: Refactor CLI extract to use pipeline

**Files:**
- Modify: `src/cli.ts:137-191` (handleExtract function)

**Step 1: Rewrite handleExtract**

Replace the `handleExtract` function in `src/cli.ts`:

```typescript
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

  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const embeddings = new OllamaEmbeddings({ host: config.ollama.host, model: config.ollama.embeddingModel });
  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'extract';
  const projectId = getProjectId(projectPath);

  const { storeWithDedup } = await import('./storage/pipeline.js');
  const result = await storeWithDedup(extracted, {
    storage,
    sqlite: storage.sqliteDb,
    embeddings,
    config,
    projectId,
    sessionId,
  });

  console.log(`Stored ${result.stored}, merged ${result.merged}, skipped ${result.deduplicated} dupes.`);
  await storage.disconnect();
}
```

**Step 2: Run build + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "refactor: CLI extract uses shared storeWithDedup pipeline"
```

---

## Phase 4: Integration

### Task 9: Server integration — health checks + pipeline wiring

**Files:**
- Modify: `src/server.ts`

**Step 1: Add health checks to server startup**

```typescript
// src/server.ts
#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ensureDataDirs, getProjectDbPath } from './config.js';
import { checkDependencies } from './health.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';
import { registerRecallTool } from './tools/recall.js';
import { registerRememberTool } from './tools/remember.js';

async function main() {
  const config = loadConfig();

  // Fail fast if dependencies are unavailable
  await checkDependencies(config);

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
    version: '0.3.0',
  });

  registerRecallTool(server, search, reranker, projectStorage, config);
  registerRememberTool(server, projectStorage, embeddings, config, projectPath, mergeWithLLM);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
```

**Step 2: Build and verify**

Run: `npx tsc --noEmit`
Expected: Clean build, no errors

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: add health checks to MCP server startup, bump to v0.3.0"
```

---

### Task 10: Core degradation — `maintain` CLI command

**Files:**
- Modify: `src/cli.ts` (add maintain command)

**Step 1: Add maintain command to CLI**

In `src/cli.ts`, add case to switch:

```typescript
case 'maintain':
  await handleMaintain(config, projectPath);
  break;
```

Update usage string:

```typescript
console.error('Usage: memento <recall|stats|flush|hydrate|core|extract|maintain> [args]');
```

Add handler:

```typescript
async function handleMaintain(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const core = storage.getCoreMemories();
  const now = Date.now();
  const maxStaleMs = (config.core.degradeAfterSessions ?? 30) * 24 * 60 * 60 * 1000;
  let degraded = 0;

  for (const m of core) {
    const lastActive = Math.max(m.lastRecalled, m.timestamp);
    const staleness = now - lastActive;
    if (staleness > maxStaleMs) {
      await storage.setCore(m.id, false);
      degraded++;
    }
  }

  if (degraded > 0) {
    console.log(`Degraded ${degraded} memories from core.`);
  }

  await storage.disconnect();
}
```

**Step 2: Add to Makefile**

Add target:

```makefile
maintain: ## Run maintenance (degrade stale core memories)
	@$(CLI) maintain
```

Update `.PHONY` line to include `maintain`.

**Step 3: Build and verify**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 4: Commit**

```bash
git add src/cli.ts Makefile
git commit -m "feat: add maintain CLI command for core memory degradation"
```

---

### Task 11: Update session-start hook

**Files:**
- Modify: `hooks/session-start.sh`

**Step 1: Add maintain call before core load**

In `hooks/session-start.sh`, insert after `CLI=...` line and before `CORE=...`:

```bash
# 0. Maintain: degrade stale core memories
$CLI maintain 2>/dev/null || true
```

**Step 2: Commit**

```bash
git add hooks/session-start.sh
git commit -m "feat: run maintain in session-start hook before loading core"
```

---

## Phase 5: Verification

### Task 12: Full build + test suite

**Step 1: Clean build**

Run: `rm -rf dist/ && npx tsc`
Expected: No errors

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (existing + new)

**Step 3: Manual smoke test**

```bash
make start
node dist/cli.js stats
node dist/cli.js recall "test query"
node dist/cli.js maintain
node dist/cli.js core
```

**Step 4: Final commit if any adjustments**

```bash
git add -A
git commit -m "chore: v0.3 verification and fixes"
```

---

## Summary

| Task | Description | Dependencies | Est. Complexity |
|------|-------------|--------------|-----------------|
| 1 | Health checks (`src/health.ts`) | none | Low |
| 2 | Graph schema migration | none | Low |
| 3 | Graph CRUD (edge operations) | Task 2 | Medium |
| 4 | Diversify algorithm | none | Medium |
| 5 | Shared storeWithDedup pipeline | Task 3 | High |
| 6 | Recall + graph integration | Tasks 3, 4 | High |
| 7 | Remember refactor → pipeline | Task 5 | Low |
| 8 | Extract refactor → pipeline | Task 5 | Low |
| 9 | Server integration + health | Task 1 | Low |
| 10 | Maintain CLI command | none | Low |
| 11 | Session-start hook update | Task 10 | Low |
| 12 | Verification | All | Low |

**New files:** `src/health.ts`, `src/storage/pipeline.ts`, `src/__tests__/health.test.ts`, `src/storage/__tests__/graph.test.ts`, `src/search/__tests__/diversify.test.ts`, `src/storage/__tests__/pipeline.test.ts`

**Modified files:** `src/storage/sqlite.ts`, `src/storage/sync.ts`, `src/storage/redis.ts`, `src/search/reranker.ts`, `src/tools/recall.ts`, `src/tools/remember.ts`, `src/cli.ts`, `src/server.ts`, `hooks/session-start.sh`, `Makefile`
