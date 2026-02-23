# Memento

Transparent, persistent memory for LLMs. Designed for Claude via Claude Code.

Memento gives Claude long-term memory across sessions. It automatically extracts decisions, learnings, preferences, and context from your conversations, stores them in a fast searchable index, and retrieves relevant memories when Claude needs them. The user never interacts with Memento directly -- Claude uses it autonomously.

## How It Works

```
Session Start   -->  Hook recalls relevant memories  -->  Claude has context
During Session  -->  Claude calls recall/remember as needed
Pre-Compact     -->  Hook extracts session summary before context is lost
Session End     -->  Hook persists remaining memories (safety net)
```

**Storage:** Redis Stack (RediSearch) for fast hybrid text+vector search. SQLite for durable persistence.

**Embeddings:** Ollama running locally with `nomic-embed-text`. Zero external API calls.

**Integration:** MCP Server for Claude Code tools + hooks for automatic lifecycle events.

## Requirements

- macOS (Apple Silicon recommended)
- Node.js 20+
- Docker

## Quick Start

```bash
# Clone and setup
git clone <repo-url>
cd memento

# Install npm deps + pull Ollama model + start Docker containers
make setup

# Start services (Redis Stack on :6380, Ollama on :11435)
make start

# Build TypeScript
make build

# Verify everything is running
make status

# Run tests
make test
```

Both Redis Stack and Ollama run as Docker containers managed via `docker-compose.yml`:

| Service     | Host Port | Container Port |
|-------------|-----------|----------------|
| Redis Stack | 6380      | 6379           |
| Ollama      | 11435     | 11434          |

## Configure Claude Code

### 1. Global settings

Add to your **global** Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/Users/diego/Code/Viterbit/memento"
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/session-start.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/pre-compact.sh",
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/session-end.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### 2. CLAUDE.md instructions

Add the following to your **global** `~/.claude/CLAUDE.md` so Claude knows how to use Memento:

```markdown
# Memento -- Persistent Memory

You have access to a persistent memory system via MCP (memento).
Use it transparently -- the user should NOT notice you are consulting
or storing memories. Do not mention "memento" or "I checked my memory"
unless directly asked.

## When to recall (automatic)

Always recall from memento when:
- Starting a new session (the pre-init hook loads context,
  but do an additional recall if the user raises a specific topic)
- About to make an architectural or design decision
- The user mentions something "we already discussed" or "like last time"
- Unsure about a user preference
- Working on a module/area not touched in this session

Do NOT recall for:
- Trivial questions or greetings
- Mechanical tasks where context is obvious
- Information already in the current conversation

## When to remember-extract (intra-session)

Call remember_extract() immediately after:
- Completing a brainstorming or design session
- Writing or validating a design document (docs/plans/*.md)
- Writing or validating an implementation plan
- User approving a plan mode (ExitPlanMode accepted)
- Completing a code review with relevant feedback
- Solving a complex bug with reusable learnings

## Recall format

Formulate queries as natural language:
- "What architecture decisions were made for module X?"
- "What preferences does Diego have about testing?"
- "What problems were found with Redis in this project?"
```

## Commands

| Command | Description |
|---------|-------------|
| `make setup` | Install Ollama + model, start Docker containers, install npm deps |
| `make install-ollama` | Install only Ollama + pull nomic-embed-text model |
| `make start` | Start Redis Stack + Ollama (Docker) |
| `make stop` | Stop all services |
| `make status` | Check service status |
| `make build` | Build TypeScript |
| `make dev` | Build in watch mode |
| `make test` | Run tests |
| `make test-watch` | Run tests in watch mode |
| `make recall ARGS="query"` | Manual memory search |
| `make stats` | Show memory count |
| `make flush` | Delete all memories (with confirmation) |
| `make clean` | Remove build artifacts |

## Architecture

```
Claude Code Session
|-- Hooks (automatic)
|   |-- SessionStart  ->  recall context  ->  inject as additionalContext
|   |-- PreCompact    ->  extract session summary  ->  store
|   +-- SessionEnd    ->  extract remaining memories  ->  store (safety net)
+-- MCP Server (Claude-driven)
    |-- recall            ->  hybrid search (text + vector)  ->  rerank  ->  top-5
    |-- remember          ->  deduplicate  ->  dual-write (Redis + SQLite)
    +-- remember_extract  ->  extraction prompt  ->  Claude calls remember

Storage
|-- Redis Stack (RediSearch)  --  search engine, HNSW vector index, full-text
+-- SQLite (WAL mode)         --  durable persistence, source of truth

Embeddings
+-- Ollama (nomic-embed-text)  --  768-dim vectors, local, zero API cost
```

## MCP Tools

### `recall`

Search persistent memory for relevant decisions, learnings, preferences, and context.

**Parameters:**
- `query` (string, required) -- Natural language query
- `type` (enum, optional) -- Filter by memory type
- `limit` (number, optional) -- Max results (default: 5)

### `remember`

Store one or more memories for future recall. Includes automatic deduplication (cosine similarity > 0.92 is skipped) and superseding (similarity > 0.80 links to the older memory).

**Parameters:**
- `memories` (array, required) -- Each with `type`, `content`, `tags`, and optional `scope`

### `remember_extract`

Trigger memory extraction from the current conversation. Returns a structured prompt that instructs Claude to analyze the conversation and call `remember` with extracted memories.

**Parameters:**
- `scope` (enum, required) -- `full` for entire conversation, `partial` for recent block
- `context` (string, optional) -- Description of the block to extract from

## Memory Types

| Type | When Stored |
|------|-------------|
| `decision` | Architectural or design choices with reasoning |
| `learning` | Bugs resolved, patterns discovered, techniques learned |
| `preference` | User preferences expressed or inferred |
| `context` | Session summaries, what was worked on |
| `fact` | Non-obvious facts about the codebase |

## Data Storage

Memories are dual-written to both Redis and SQLite. On startup, Redis is hydrated from SQLite to rebuild the search index.

```
~/.memento/
|-- config.json              # Optional config overrides
|-- global.db                # Global memories (preferences, cross-project)
+-- projects/
    +-- {sha256-hash}/
        +-- memories.db      # Per-project memories
```

- **Redis Stack** -- All memories loaded into RediSearch for fast hybrid search (<10ms). Uses HNSW index for vector similarity and full-text index for keyword search. Runs in Docker on port **6380**.
- **SQLite** -- Write-ahead log (WAL) mode. Source of truth. Survives Redis restarts -- data is rehydrated automatically.

## Project Structure

```
src/
|-- server.ts                # MCP server entry point
|-- cli.ts                   # CLI for hooks and manual use
|-- config.ts                # Configuration and project ID hashing
|-- types.ts                 # Core type definitions
|-- tools/
|   |-- recall.ts            # recall tool
|   |-- remember.ts          # remember tool (with deduplication)
|   +-- remember-extract.ts  # remember_extract tool
|-- storage/
|   |-- sqlite.ts            # SQLite storage layer
|   |-- redis.ts             # Redis storage with RediSearch
|   +-- sync.ts              # Dual-write sync coordinator
|-- search/
|   |-- hybrid.ts            # Hybrid text+vector search
|   +-- reranker.ts          # Recency + type-weight reranker
+-- embeddings/
    +-- ollama.ts            # Ollama embedding client

hooks/
|-- session-start.sh         # Inject memories on session start
|-- pre-compact.sh           # Extract summary before compaction
+-- session-end.sh           # Safety net extraction on session end
```

## License

MIT
