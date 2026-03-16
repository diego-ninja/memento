# Memento v0.3 — Resilience, Graph, and Quality

## Problem

Memento v0.2 has the right architecture but several gaps block reliable daily use:

1. **No resilience** — if Redis or Ollama are down, the MCP server crashes. No health checks, no clear messages.
2. **Extract bypasses dedup** — session-end extraction stores memories directly, creating duplicates.
3. **Recall wastes slots** — 3 result slots can be filled with near-identical memories. No diversity enforcement.
4. **Merge blocks write path** — LLM merge takes 2-5s synchronously during `remember`.
5. **No memory navigation** — flat list of results with no way to explore related context.
6. **Core grows forever** — promotion works but no degradation mechanism.

## Goals

- Fail fast with clear messages when infrastructure is unavailable
- Zero duplicate memories from any write path (tool or CLI)
- Diverse recall results with navigable graph of related memories
- Non-blocking write path (<100ms for remember response)
- Self-maintaining core memory (auto-promote + auto-degrade)

## Design

### 1. Resilience — Fail fast

New function `checkDependencies(config)` runs before tool registration in `server.ts`.

```
Check order:
1. Redis ping → hard fail: "Memento: Redis not available at {host}:{port}"
2. Ollama GET /api/tags → hard fail: "Memento: Ollama not available at {host}"
3. Embedding model in tags list → hard fail: "Memento: model {model} not found in Ollama"
4. Generative model in tags list → soft warning to stderr (merge/extract degrade, recall/remember work)
```

Hard fail = `process.exit(1)` with message to stderr.
Soft warning = log to stderr, continue.

Hooks unchanged — they already use `|| true` on CLI calls. If CLI fails, hook exits cleanly with no injection. Correct behavior for fail fast.

```typescript
// src/health.ts
export async function checkDependencies(config: MementoConfig): Promise<void> {
  // 1. Redis
  const redis = new Redis({ host: config.redis.host, port: config.redis.port, lazyConnect: true });
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
    const data = await res.json();
    const models = new Set(data.models.map((m: any) => m.name.split(':')[0]));

    if (!models.has(config.ollama.embeddingModel)) {
      console.error(`Memento: embedding model '${config.ollama.embeddingModel}' not found in Ollama`);
      process.exit(1);
    }

    if (!models.has(config.ollama.generativeModel.split(':')[0])) {
      console.error(`Memento: generative model '${config.ollama.generativeModel}' not available (merge/extract will degrade)`);
    }
  } catch {
    console.error(`Memento: Ollama not available at ${config.ollama.host}`);
    process.exit(1);
  }
}
```

### 2. Shared dedup/merge pipeline

Extract dedup/merge logic from `remember` tool into a shared module.

New file: `src/storage/pipeline.ts`

```typescript
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

export async function storeWithDedup(
  inputs: StoreInput[],
  storage: SyncStorage,
  embeddings: OllamaEmbeddings,
  config: MementoConfig,
  projectId: string,
  sessionId: string,
  mergeWithLLM?: (old: string, new_: string) => Promise<string>,
): Promise<StoreResult>
```

Logic (moved from remember tool):
1. Batch generate embeddings
2. For each input: vector search top-1 existing
3. Similarity > 0.92 → skip (deduplicated)
4. Similarity 0.80-0.92 → store new + create graph edge + fire-and-forget background merge
5. Similarity 0.70-0.80 → store new + create graph edge (related but distinct)
6. Similarity < 0.70 → store new (unrelated)

Consumers:
- `remember` tool: validates input → calls `storeWithDedup()` → formats response
- `cli extract`: extracts from transcript → calls `storeWithDedup()` → logs result
- Any future write path

The `remember` tool becomes ~20 lines: schema definition + call pipeline + format output.

### 3. Memory graph — Persistent relations

#### Schema

```sql
CREATE TABLE memory_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  similarity REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id),
  FOREIGN KEY (source_id) REFERENCES memories(id),
  FOREIGN KEY (target_id) REFERENCES memories(id)
);
CREATE INDEX idx_edges_source ON memory_edges(source_id);
CREATE INDEX idx_edges_target ON memory_edges(target_id);
```

Edges are bidirectional: if A→B exists with similarity 0.78, B→A also exists.

#### Construction (write-time)

During `storeWithDedup`, after storing a new memory:

```
1. Vector search top-20 existing memories (already done for dedup)
2. For each result with similarity > 0.70 and < 0.92:
   - INSERT edge (new_id, existing_id, similarity)
   - INSERT edge (existing_id, new_id, similarity) -- bidirectional
3. Marginal cost: N INSERTs in SQLite (~1ms total)
```

No Redis involvement for the graph — SQLite only. The graph is for navigation and ranking signals, not for search.

#### Navigation in recall

New optional parameter `expand` in recall tool:

```typescript
{
  query: z.string().describe('Natural language query'),
  expand: z.string().optional().describe('Memory ID to expand neighbors from graph'),
  type: z.enum([...]).optional(),
  limit: z.number().optional(),
}
```

When `expand` is provided:
1. Load the memory by ID
2. Load its graph neighbors (edges WHERE source_id = id, JOIN memories)
3. Return the memory + neighbors in compact format

When `expand` is NOT provided (normal recall):
1. RRF search → rerank → diversify → top-3
2. Take remaining memories from top-20, cluster by graph connectivity
3. Append "-- related --" section with cluster summaries

Output format:

```
D|0310|memento: Redis=search, SQLite=backup
P|0308|prefer heuristics>AI classification
L|0224|hover:bg-foreground/10 replaces black/white

-- related --
[a1b2c3] DDD: VOs immutable, equality by value (4 connections)
[d4e5f6] testing: VOs need equals/hashCode tests (2 connections)
```

Short IDs are the first 6 chars of the memory ID. Claude calls `recall({expand: "a1b2c3"})` to navigate.

#### Ranking signal (graph degree)

Each memory's degree (number of edges) feeds the reranker:

```typescript
const graphBoost = 1 + Math.log2(1 + degree) * 0.1;
```

| Degree | Boost |
|--------|-------|
| 0 | 1.00 |
| 1 | 1.10 |
| 3 | 1.20 |
| 7 | 1.30 |
| 15 | 1.40 |

Hub memories (foundational decisions, recurring patterns) naturally rank higher.

#### Auto-promote via degree

New promotion criterion: `degree >= 10` → auto-promote to core.

A memory connected to 10+ others is clearly foundational. This complements the existing recall-count based promotion.

#### Maintenance

- **On merge:** edges from old memory transfer to merged memory. Old memory + its edges deleted.
- **On flush:** `DELETE FROM memory_edges` (full wipe).
- **On delete (future):** cascade delete edges.

### 4. Semantic grouping (diversify)

#### Embeddings in search results

Update `rawHashToMemory()` in Redis storage to parse the embedding blob from search results instead of returning `embedding: []`. The HNSW vector is stored as FLOAT32 buffer — decode it.

For `parseSearchResults()`: request the embedding field in FT.SEARCH results via RETURN clause, or read from the hash fields already returned.

#### Diversify algorithm

New method in Reranker:

```typescript
diversify(results: RecallResult[], finalK: number, threshold: number = 0.85): RecallResult[] {
  const selected: RecallResult[] = [];
  const relatedCounts = new Map<string, number>();

  for (const r of results) {
    if (selected.length >= finalK) break;

    const tooSimilar = selected.some(s =>
      cosineSimilarity(r.memory.embedding, s.memory.embedding) > threshold
    );

    if (tooSimilar) {
      // Find which selected memory it's similar to, increment related count
      for (const s of selected) {
        if (cosineSimilarity(r.memory.embedding, s.memory.embedding) > threshold) {
          relatedCounts.set(s.memory.id, (relatedCounts.get(s.memory.id) ?? 0) + 1);
          break;
        }
      }
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

Reranker now requests `finalK * 3` from internal scoring, then diversifies down to `finalK`.

Output format includes `(+N related)` suffix when relatedCount > 0.

### 5. Merge fire-and-forget

#### New flow in storeWithDedup

When similarity is 0.80-0.92:

```
1. Store the new memory normally (immediate)
2. Create graph edge between old and new (immediate)
3. Fire-and-forget background merge:
   a) mergeWithLLM(old.content, new.content)
   b) Generate new embedding for merged content
   c) Update newer memory with merged content + embedding
   d) Transfer edges from old to new
   e) Delete old memory
4. Return "Stored 1" immediately (no waiting)
```

If generative model unavailable: merge doesn't happen. Two similar memories coexist, connected by graph edge. Semantic grouping collapses them in recall output. No data loss.

Implementation: simple `Promise` with `.catch(console.error)`. No job queue needed for personal use.

#### New storage methods needed

```typescript
// SqliteStorage
transferEdges(fromId: string, toId: string): void
deleteMemory(id: string): void  // DELETE from memories + edges

// SyncStorage
transferEdges(fromId: string, toId: string): void
deleteMemory(id: string): Promise<void>  // SQLite + Redis
```

### 6. Core degradation

#### CLI command: `memento maintain`

```
1. Load all core memories
2. For each: calculate staleness = Date.now() - max(lastRecalled, timestamp)
3. If staleness > 30 days → setCore(false)
4. Log: "Degraded N memories from core"
```

Using `max(lastRecalled, timestamp)` handles the edge case of memories manually promoted to core that were never recalled — they get 30 days from creation before degrading.

#### Integration

Session-start hook runs maintain before loading core:

```bash
$CLI maintain 2>/dev/null || true
CORE=$($CLI core 2>/dev/null || true)
```

Runs once per session. Cost: 1 SQLite query + N updates. <10ms.

### 7. Tests

New test files:

- `src/storage/__tests__/pipeline.test.ts` — storeWithDedup: dedup, merge trigger, graph edge creation, batch embeddings
- `src/storage/__tests__/graph.test.ts` — edges CRUD, transferEdges, degree calculation, neighbor query
- `src/search/__tests__/diversify.test.ts` — diversify with similar results, related counts, threshold behavior
- `src/extract/__tests__/extract.test.ts` — parseExtraction with valid/malformed JSONL, extractWithRegex patterns

## Architecture after v0.3

```
Claude Code Session
  |
  +-- session-start hook
  |     1. maintain (degrade stale core)
  |     2. Load core memories
  |     3. Contextual archival recall
  |     4. Inject: == core == / == recent ==
  |
  +-- MCP Server (2 tools: recall, remember)
  |     recall:   RRF → rerank (with graph degree boost) → diversify → top-3
  |               + "-- related --" section from graph
  |               + expand param for graph navigation
  |               + increment recall_count (fire-and-forget)
  |     remember: validate → storeWithDedup pipeline
  |               pipeline: batch embed → dedup → store → build edges → bg merge
  |
  +-- pre-compact hook
  |     1-line reminder → Claude calls remember()
  |
  +-- session-end hook
        extract (Ollama/regex) → storeWithDedup pipeline → store via CLI

Storage:
  SQLite: memories table + memory_edges table (graph)
  Redis: search index (RediSearch + HNSW)

Infrastructure:
  Redis Stack --- port 6380
  Ollama (nomic-embed-text + qwen2.5:3b) --- port 11435
```

## Migration from v0.2

- New table `memory_edges` (auto-created by SQLite migration)
- Existing memories have no edges initially — edges build up organically as new memories are stored
- No Redis index changes needed (graph is SQLite-only)
- `remember` tool schema unchanged (consumers unaffected)
- `recall` tool gets new optional `expand` parameter (backward compatible)
- `storeWithDedup` extracted from remember — internal refactor, no API change
- New CLI commands: `maintain`
- `rawHashToMemory` updated to include embeddings — internal change

## References

- Letta/MemGPT: memory graph for agent navigation
- Cognee: knowledge graph from unstructured data
- Zep/Graphiti: relationship modeling between memories
- MMR (Maximal Marginal Relevance): diversity in information retrieval
