# Memento v0.2 — Optimization & Refinement

## Problem

Memento v0.1 is architecturally sound but not working in practice:

1. **Hooks are broken** — session-start is slow (hydrate on every boot), pre-compact is a no-op, session-end only updates stats
2. **Context is bloated** — injected memories are verbose and often irrelevant, recall/remember consume too many tokens
3. **Search is fragile** — hybrid search silently falls back to vector-only or text-only, no real score fusion

## Goals (updated)

- MCP server startup <100ms (currently 2-5s)
- Recall response <150 tokens for 5 memories (currently ~500)
- Hooks fully autonomous — extraction without consuming Opus context
- Search with real score fusion via RRF
- Core memory always available — no recall needed for critical context
- Memory base stays compact — merge instead of accumulate

## Design

### 1. Startup — Hydrate out of hot path

Current: `server.ts` does `await storage.hydrate()` on boot, loading ALL memories from SQLite to Redis sequentially.

New: lazy hydrate.

```
Boot sequence:
1. Connect Redis
2. FT.INFO → check num_docs
3. If num_docs > 0 → skip hydrate, register tools (~50ms)
4. If num_docs == 0 → hydrate in background (non-blocking), register tools immediately
```

New CLI command: `memento hydrate` for manual/cron use. Also runs on `make start` after services are up.

Fallback: if a recall arrives before hydrate finishes, Redis may have partial data. Acceptable — SQLite is for durability, not real-time queries.

### 2. Search — Reciprocal Rank Fusion (RRF)

Current: `HybridSearch` tries Redis hybrid query, catches errors silently, falls back to vector-only then text-only. Scores are positional (`1 - index/total`), meaningless.

New: parallel text + vector, fused with RRF.

```
1. Generate embedding via Ollama (~50ms)
2. In parallel:
   a) FT.SEARCH text query (top-K=20)
   b) FT.SEARCH KNN vector (top-K=20)
3. RRF fusion: score = SUM(1/(k + rank)) where k=60
4. Reranker: type boost * recency boost * RRF score
5. Return top-N (default 3)
```

RRF properties:
- Memory in both lists gets boosted naturally (sum of both ranks)
- Semantically relevant but different wording → boosted by vector rank
- Exact keyword match but distant embedding → boosted by text rank
- No silent fallbacks, no empty catches

Reranker change: receives real RRF scores instead of positional. Type/recency boosts are multipliers on meaningful scores.

### 3. Memory format — Telegraphic and compact

Memories are for Claude, not humans. Optimize for token efficiency.

#### Write-time: telegraphic content

The `remember` tool instructs Claude to write content as compressed notes-to-self:

```
Before: "Para memento, elegimos Redis como motor de busqueda principal con SQLite como persistencia durable."
After:  "memento: Redis=search primary, SQLite=persistence backup"
```

No articles, no filler words, only dense information.

#### Read-time: ultra-compact output format

```
Before:
1. [decision] (2026-02-24) [redis, sqlite, architecture]
   Para memento, elegimos Redis como motor de busqueda principal...

After:
D|0224|memento: Redis=search primary, SQLite=persistence backup
```

- Type: single char (D=decision, L=learning, P=preference, F=fact, C=context)
- Date: MMDD (year rarely matters, recency is implicit in ordering)
- Content: telegraphic, no extra separator
- No tags (redundant with content + embedding)
- No scores (Claude doesn't need them)

Estimated reduction: ~30 tokens/memory to ~12-15. Five memories: ~500 tokens to ~75.

#### Semantic grouping

If 2+ results have cosine similarity >0.85 between them, collapse to most recent with `(+N related)`:

```
D|0310|memento: Redis=search, SQLite=backup
P|0308|prefer heuristics>AI classification
L|0224|hover:bg-foreground/10 replaces black/white pattern (+2 related)
```

### 4. Schema simplification

#### Remove `tags` from input

Tags are redundant with embeddings (for search) and content (for reading). Remove from the `remember` tool input. Internally, store empty array for index compatibility.

#### Remove `scope` from input

Default `project`. Global scope is rare and can be revisited later. Remove from tool input, hardcode default.

#### Minimal remember input

```typescript
// Before
{ type: 'decision', content: '...', tags: ['redis', 'arch'], scope: 'project' }

// After
{ type: 'decision', content: 'memento: Redis=search, SQLite=backup' }
```

#### Batch embeddings

`remember` with N memories uses `generateBatch()` (already exists in OllamaEmbeddings) instead of N individual `generate()` calls.

```
Before:  5 memories -> 5 Ollama calls (~250ms)
After:   5 memories -> 1 batch call (~60ms)
```

### 5. Hooks — Complete redesign

#### session-start: Contextual recall

Current: generic query "recent project context decisions and preferences" — brings irrelevant results.

New: read project CLAUDE.md first 20 lines as context for the recall query.

```bash
# Extract project context
CONTEXT=$(head -20 "$PROJECT_DIR/CLAUDE.md" 2>/dev/null | tr '\n' ' ' | cut -c1-200)
QUERY="key decisions, preferences and learnings for: $CONTEXT"

# Recall with contextual query
MEMORIES=$($CLI recall "$QUERY")
```

Output max 5 memories in compact format. Inject as additionalContext.

#### pre-compact: Extraction reminder

Current: no-op.

New: inject a single-line reminder (~15 tokens) for Claude to call `remember` directly:

```json
{
  "additionalContext": "MEMENTO: persist key memories now via remember() before context compaction"
}
```

Claude already knows what to extract from CLAUDE.md instructions. No prompt, no extra tool, no roundtrip.

#### session-end: Autonomous extraction with Ollama

Current: only updates stats.

New: extract memories from transcript using a local generative model, completely outside Claude's context window.

```
1. Read transcript file
2. Send to Ollama generative model (qwen2.5:3b) with extraction prompt
3. Parse extracted memories
4. Store via CLI (memento remember)
5. Update stats
```

Fallback if Ollama generative model is unavailable: regex heuristic.

```bash
# Patterns indicating valuable memories
grep -iE "(decided|chosen|prefer|learned|the problem was|root cause|agreed|architecture)" "$TRANSCRIPT"
```

Each match stored as type `context`. Low quality but better than losing everything.

### 6. Extraction provider config

Ollama local as default. Config supports future providers:

```json
{
  "extraction": {
    "provider": "ollama",
    "ollama": {
      "model": "qwen2.5:3b"
    },
    "anthropic": {
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

Only `ollama` provider implemented in v0.2. `anthropic` is a placeholder for future implementation.

### 7. Eliminate `remember_extract` tool

The MCP tool `remember_extract` is removed entirely:

- Intra-session: Claude calls `remember` directly (guided by CLAUDE.md instructions)
- pre-compact: hook injects 1-line reminder, Claude calls `remember`
- session-end: Ollama extracts autonomously, stores via CLI

This eliminates one tool, one roundtrip, and ~200 tokens of extraction prompt per invocation.

### 8. Core Memory vs Archival Memory

Inspired by Letta/MemGPT's OS-like memory hierarchy.

#### The problem

session-start does a recall query that may return irrelevant results. Critical context (project identity, foundational decisions, key preferences) should ALWAYS be available without a search.

#### Two tiers

- **Core memory** (`is_core: true`): 5-10 memories always injected at session-start. No recall needed. These are the "RAM" — project identity, architecture decisions, user preferences that apply to every session.
- **Archival memory** (`is_core: false`): everything else. Retrieved on-demand via `recall`. This is the "disk".

#### Promotion and degradation

Automatic, based on usage signals:

- **Promote to core**: memory recalled 3+ times across different sessions → auto-promote
- **Degrade from core**: core memory not recalled/referenced in 30+ sessions → auto-degrade to archival
- **Manual override**: `remember` accepts `core: true` for memories Claude knows are foundational

```
session-start injection:
1. Load all core memories (no search, just filter is_core=true)
2. Optionally: contextual recall for archival (current v0.2 behavior)
3. Inject core first, then archival results
```

Format:

```
== core ==
D|0223|memento: Redis=search, SQLite=backup, Ollama=embeddings
P|0224|Diego: heuristics>AI classification, review plans before impl
D|0224|memory format: telegraphic, one-line, for LLM consumption

== recent ==
L|0310|RRF k=60 outperforms single-source search
```

Core block is stable across sessions (~50 tokens). Archival block varies per recall.

#### Schema change

```sql
ALTER TABLE memories ADD COLUMN is_core INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN recall_count INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_recalled INTEGER DEFAULT 0;
```

Redis: add `is_core` as TAG field, `recall_count` and `last_recalled` as NUMERIC SORTABLE.

### 9. Recall frequency tracking

Every time `recall` returns a memory, increment its `recall_count` and update `last_recalled` timestamp.

```typescript
// In recall tool, after reranking
for (const result of ranked) {
  await storage.incrementRecallCount(result.memory.id);
}
```

This feeds three systems:

1. **Core promotion**: recall_count >= 3 across different sessions → promote
2. **Reranker boost**: frequently recalled memories get a small boost (sqrt(recall_count) * 0.05)
3. **Stats/observability**: "which memories are actually useful?"

The increment is fire-and-forget (non-blocking). A failed increment doesn't affect the recall response.

### 10. Memory merge instead of supersede

Current v0.1: when similarity is 0.80-0.92, create a new memory with `supersedes: old_id`. The old memory stays in the index, cluttering results. The reranker filters it, but it still wastes a slot in top-K.

New: **merge** the old and new content into a single memory.

```
Existing: "memento: Redis=search primary, SQLite=backup"
New:      "memento: Redis=search+vectors, SQLite=WAL mode, batch hydrate"
Merged:   "memento: Redis=search+vectors primary, SQLite=WAL backup, batch hydrate on start"
```

#### Merge strategy

The merge is done by the extraction model (Ollama qwen2.5:3b) — same model used for session-end extraction:

```
1. New memory arrives, embedding generated
2. Vector search finds existing memory with similarity 0.80-0.92
3. Send both to Ollama: "merge these two facts into one concise note: [old] [new]"
4. Replace old memory in SQLite + Redis with merged content + new embedding
5. Preserve the older timestamp (continuity) but update session_id
```

If Ollama generative model is unavailable, fall back to current `supersedes` behavior.

#### Benefits

- Memory base stays compact — doesn't grow with every refinement
- No stale memories in the index
- Merged memory has richer content than either original
- The `supersedes` field becomes unnecessary for new memories (kept for backward compat)

## Architecture after v0.2

```
Claude Code Session
  |
  +-- session-start hook
  |     1. Load core memories (is_core=true, no search)
  |     2. Contextual recall for archival (CLAUDE.md as query context)
  |     3. Inject: == core == block + == recent == block
  |
  +-- MCP Server (2 tools: recall, remember)
  |     recall:   RRF search (text||vector) -> rerank -> compact -> 3 results
  |               + increment recall_count (fire-and-forget)
  |               + auto-promote to core if recall_count >= 3
  |     remember: telegraphic input -> batch embed -> dedup/merge -> dual-write
  |               merge via Ollama 3B if similarity 0.80-0.92
  |
  +-- pre-compact hook
  |     Inject 1-line reminder -> Claude calls remember()
  |
  +-- session-end hook
        Read transcript -> Ollama 3B extraction -> store via CLI
        Fallback: regex heuristic

Infrastructure:
  Redis Stack (RediSearch + HNSW) --- port 6380
  Ollama (nomic-embed-text + qwen2.5:3b) --- port 11435
  SQLite (~/.memento/) --- durable backup

Memory hierarchy:
  Core (5-10 memories, always in context) ←→ Archival (on-demand via recall)
  Promotion: recall_count >= 3 | Manual (core: true)
  Degradation: not recalled in 30+ sessions
```

## Migration

- `tags` field stays in Redis index and SQLite schema (empty for new memories)
- `scope` field stays in schema (defaults to "project")
- Existing memories keep their format — only new memories are telegraphic
- `remember_extract` tool removed — no backward compatibility needed (only Claude calls it)
- New columns: `is_core` (default 0), `recall_count` (default 0), `last_recalled` (default 0)
- `supersedes` field kept for backward compat but not used for new memories (merge replaces it)

## Summary of token savings

| Operation | Before | After |
|-----------|--------|-------|
| session-start: core memories (~7) | N/A (no concept) | ~50 tokens (stable) |
| session-start: archival recall (~3) | ~500 tokens | ~35 tokens |
| Single recall response (3 results) | ~300 tokens | ~45 tokens |
| remember_extract roundtrip | ~400 tokens | 0 (eliminated) |
| pre-compact hook | 0 (no-op) | ~15 tokens |
| session-end extraction | 0 (stats only) | 0 (autonomous) |
| recall_count increment | N/A | 0 (fire-and-forget, no output) |
| memory merge (Ollama) | N/A | 0 (server-side, no output) |
| **Total per-session overhead** | **~1200 tokens** | **~145 tokens** |

## References

Approaches from the open-source landscape that influenced this design:

- **Letta/MemGPT**: core vs archival memory hierarchy, OS-inspired memory management
- **SimpleMem**: write-time semantic compression, on-the-fly synthesis
- **Mem0**: recall frequency as signal, memory importance scoring
- **Zep/Graphiti**: temporal awareness (our `last_recalled` + degradation)
