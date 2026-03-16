# Memento

Persistent memory system for LLMs with lossless transcript management. Designed for Claude via Claude Code.

Memento operates as an **engine-lite**: a two-layer memory system that captures everything and forgets nothing. The **knowledge layer** stores distilled facts, decisions, and preferences. The **transcript layer** stores full session history with a hierarchical summary DAG, enabling regex search and lossless drill-down across all past conversations.

Inspired by the [Lossless Context Management (LCM)](https://papers.voltropy.com/LCM) architecture.

## How It Works

```
Session Start ──> inject core memories + recent session summaries
                  (if resuming after compaction: inject recovery context)
                       │
                       ▼
  ┌──────────── TURN LOOP ─────────────┐
  │ UserPromptSubmit ──> persist user    │
  │ PostToolUse ────────> persist tools  │
  │ Stop ───────────────> persist reply  │
  └──────────────────────────────────────┘
                       │
              [context fills up]
                       │
  PreCompact ──> generate checkpoint summary ──> inject as context
  PostCompact ─> capture Claude's compact_summary
  SessionStart(compact) ──> inject rich recovery context
                       │
  Session End ──> batch ingest full transcript
                  extract knowledge memories
                  detect file artifacts
                  link related sessions
                  build summary DAG (async)
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    MCP Tools (7)                              │
│  recall · remember · transcript_grep · transcript_expand     │
│  transcript_describe · llm_map                               │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  Knowledge Layer                                             │
│  memories + edges + dedup + merge + diversify                │
├──────────────────────────────────────────────────────────────┤
│  Transcript Layer                                            │
│  sessions + messages + FTS5 + summary DAG + artifacts        │
├──────────────────────────────────────────────────────────────┤
│  Engine-Lite (hooks)                                         │
│  real-time ingest + compaction awareness + context recovery   │
└──────────────────────────────────┬──────────────────────────┘
                              ┌────▼────┐
                              │ SQLite  │
                              │  + vec  │
                              └─────────┘
```

**Storage:** SQLite (WAL mode) with [sqlite-vec](https://github.com/asg017/sqlite-vec) for HNSW vector search and FTS5 for full-text search. Single file per project, zero infrastructure.

**Embeddings:** Ollama with `nomic-embed-text` (768-dim). Zero external API calls.

**Summarization:** Ollama with `qwen2.5:3b` for summaries and extraction. Three-level escalation guarantees convergence (LLM -> bullet points -> deterministic truncate).

## Requirements

- macOS (Apple Silicon recommended) or Linux
- Node.js 20+
- Docker (only for Ollama, or install Ollama natively)

## Quick Start

```bash
git clone https://github.com/diego-ninja/memento.git
cd memento

# Install deps + start Ollama + build + pull models
make setup

# Start Ollama
make start

# Verify
make status
make test
```

### Infrastructure

| Component   | Type        | Purpose                      |
|-------------|-------------|------------------------------|
| SQLite      | Embedded    | All storage (memories, transcripts, vectors, FTS) |
| sqlite-vec  | Extension   | HNSW vector search           |
| Ollama      | Docker/Native | Embeddings + summarization (local LLM) |

Ollama runs as a Docker container on port 11435 by default. Alternatively, install Ollama natively and point `MEMENTO_OLLAMA_HOST` to it.

## Configure Claude Code

### 1. MCP Server

Add to your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/path/to/memento"
    }
  }
}
```

### 2. Hooks

Add to your **global** `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup", "hooks": [{ "type": "command", "command": "/path/to/memento/hooks/session-start.sh", "timeout": 10 }] },
      { "matcher": "compact", "hooks": [{ "type": "command", "command": "/path/to/memento/hooks/session-start.sh", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "/path/to/memento/hooks/user-prompt.sh", "timeout": 3 }] }
    ],
    "Stop": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "/path/to/memento/hooks/stop.sh", "timeout": 3 }] }
    ],
    "PostToolUse": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "/path/to/memento/hooks/post-tool.sh", "timeout": 3 }] }
    ],
    "PreCompact": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "/path/to/memento/hooks/pre-compact.sh", "timeout": 15 }] }
    ],
    "PostCompact": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "/path/to/memento/hooks/post-compact.sh", "timeout": 5 }] }
    ],
    "SessionEnd": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "/path/to/memento/hooks/session-end.sh", "timeout": 30 }] }
    ]
  }
}
```

### 3. CLAUDE.md instructions

Add to your **global** `~/.claude/CLAUDE.md`:

```markdown
# Memento -- Persistent Memory

You have access to a persistent memory system via MCP (memento).
Use it transparently -- the user should NOT notice you are consulting
or storing memories.

## When to recall (automatic)

- Starting a new session (hooks load context, but recall for specific topics)
- Before architectural or design decisions
- When the user references something "we discussed" or "last time"
- Unsure about a user preference

## When to remember

Call remember() immediately after:
- Completing a brainstorming or design session
- Writing or validating a design document
- User approving a plan
- Solving a complex bug with reusable learnings

## Transcript tools

- transcript_grep(pattern) — search full session history across all sessions
- transcript_expand(id) — drill into any summary to see original messages
- transcript_describe(id) — quick metadata for sessions, summaries, artifacts
```

## MCP Tools

### Knowledge Layer

| Tool | Description |
|------|-------------|
| `recall` | Hybrid text+vector search over distilled memories. Returns top-3 with graph-based diversity. |
| `remember` | Store memories with automatic dedup (>0.92 skip), merge (0.80-0.92), and graph edge creation. |

### Transcript Layer

| Tool | Description |
|------|-------------|
| `transcript_grep` | Substring/FTS5 search across all past session transcripts. Filter by session, role, limit. |
| `transcript_expand` | Lossless drill-down: summary ID, session ID, or message ID -> original messages with context. |
| `transcript_describe` | Metadata inspection for sessions (with artifacts, linked sessions), summaries, messages. |

### Operators

| Tool | Description |
|------|-------------|
| `llm_map` | Process N items in parallel with a prompt template. Configurable concurrency and retries. |

## Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| `session-start.sh` | SessionStart (startup/compact) | Inject core memories + session summaries. Post-compact: inject recovery context. |
| `user-prompt.sh` | UserPromptSubmit | Real-time capture of user prompts to immutable store. |
| `stop.sh` | Stop | Real-time capture of assistant responses. |
| `post-tool.sh` | PostToolUse | Real-time capture of tool calls (Read, Write, Bash, etc). |
| `pre-compact.sh` | PreCompact | Generate checkpoint summary and inject as additionalContext (survives compaction). |
| `post-compact.sh` | PostCompact | Capture Claude Code's compact_summary into the summary DAG. |
| `subagent-stop.sh` | SubagentStop | Ingest sub-agent transcripts + persist final message in parent session. |
| `session-end.sh` | SessionEnd | Batch ingest transcript + extract memories + detect artifacts + link sessions + build DAG. |

## Data Storage

```
~/.memento/
├── config.json                  # Optional config overrides
└── projects/
    └── {sha256-hash}/
        ├── memories.db          # Knowledge layer (memories + edges + vector index)
        └── transcripts.db       # Transcript layer (sessions, messages, summaries, artifacts)
```

### Knowledge Layer (memories.db)

| Table | Purpose |
|-------|---------|
| `memories` | Distilled knowledge: decisions, learnings, preferences, facts |
| `memories_fts` | FTS5 full-text search index |
| `vec_memories` | sqlite-vec HNSW vector index (768-dim embeddings) |
| `memory_edges` | Semantic graph: bidirectional edges between related memories |

### Transcript Layer (transcripts.db)

| Table | Purpose |
|-------|---------|
| `sessions` | Session metadata with root summary pointer |
| `messages` | Immutable verbatim transcript (every message, every turn) |
| `messages_fts` | FTS5 virtual table for full-text search |
| `summaries` | Hierarchical DAG nodes (leaf, condensed, compact_capture) |
| `summary_sources` | DAG edges: summary -> messages/summaries (provenance) |
| `artifacts` | Tracked file references with exploration summaries |
| `session_edges` | Cross-session links (continuation, related) |

## Memory Types

| Type | Purpose |
|------|---------|
| `decision` | Architectural or design choices |
| `learning` | Bugs resolved, patterns discovered |
| `preference` | User preferences expressed or inferred |
| `context` | Session summaries, work context |
| `fact` | Non-obvious codebase facts |

## CLI Commands

### Knowledge

| Command | Description |
|---------|-------------|
| `recall <query>` | Search memories |
| `stats` | Show memory count |
| `core` | List core memories |
| `maintain` | Degrade stale core memories (>30 days) |
| `extract <transcript>` | Extract memories from a transcript file |
| `flush` | Delete all memories |

### Transcript

| Command | Description |
|---------|-------------|
| `sessions --recent N` | List recent sessions with summaries |
| `ingest-message --session <id> --role <role> --content <text>` | Persist a single message (used by hooks) |
| `ingest-transcript --session <id> --path <file>` | Batch ingest a full JSONL transcript |
| `build-dag --session <id>` | Build hierarchical summary DAG |
| `checkpoint --session <id>` | Generate session checkpoint for pre-compact |
| `session-summary --session <id>` | Get root summary of a session |
| `store-compact-summary --session <id> --summary <text>` | Store Claude's compact_summary |
| `detect-artifacts --session <id>` | Find and store file artifacts |
| `link-sessions` | Create edges between related sessions |

## Project Structure

```
src/
├── server.ts                   # MCP server entry point (7 tools)
├── cli.ts                      # CLI for hooks and manual use
├── config.ts                   # Configuration + project paths
├── types.ts                    # Core type definitions
├── extract.ts                  # Transcript extraction (LLM + regex)
├── tools/
│   ├── recall.ts               # Knowledge recall with graph boost + diversify
│   ├── remember.ts             # Knowledge store with dedup pipeline
│   ├── transcript-grep.ts      # Regex/FTS search over transcripts
│   ├── transcript-expand.ts    # Lossless summary -> message drill-down
│   ├── transcript-describe.ts  # Metadata inspection
│   └── llm-map.ts              # Parallel batch processing operator
├── transcript/
│   ├── db.ts                   # TranscriptDb (SQLite: sessions, messages, summaries, artifacts, edges)
│   ├── parse.ts                # Claude Code JSONL transcript parser
│   ├── ingest.ts               # Single message + batch transcript ingestion
│   ├── summarize.ts            # Three-level escalation + DAG construction
│   ├── artifacts.ts            # File artifact detection + exploration summaries
│   ├── session-edges.ts        # Cross-session edge detection
│   └── tokens.ts               # Token estimator
├── storage/
│   ├── unified.ts              # UnifiedStorage (SQLite + sqlite-vec + FTS5)
│   └── pipeline.ts             # Shared dedup/merge pipeline
├── search/
│   ├── hybrid.ts               # Hybrid text+vector search (RRF fusion)
│   └── reranker.ts             # Recency + type weight + graph degree ranking
└── embeddings/
    └── ollama.ts               # Ollama client (embeddings + merge + summarize)

hooks/
├── session-start.sh            # Startup + post-compact recovery
├── user-prompt.sh              # Real-time user prompt capture
├── stop.sh                     # Real-time assistant response capture
├── post-tool.sh                # Real-time tool call capture
├── pre-compact.sh              # Checkpoint summary injection
├── post-compact.sh             # Compact summary capture
└── session-end.sh              # Final ingest + extract + DAG + artifacts + edges
```

## Configuration

Default config (override via `~/.memento/config.json`):

```json
{
  "ollama": {
    "host": "http://127.0.0.1:11435",
    "embeddingModel": "nomic-embed-text",
    "generativeModel": "qwen2.5:3b"
  },
  "search": {
    "topK": 20,
    "finalK": 3,
    "deduplicationThreshold": 0.92,
    "mergeThreshold": 0.80,
    "rrfK": 60
  },
  "core": {
    "promoteAfterRecalls": 3,
    "degradeAfterSessions": 30
  }
}
```

## License

MIT
