# Memento

Persistent memory system for LLMs with lossless transcript management via MCP + Claude Code hooks.

## Project Structure

- `src/server.ts` — MCP server (7 tools: recall, remember, transcript_grep, transcript_expand, transcript_describe, llm_map)
- `src/cli.ts` — CLI for hooks and manual use
- `src/tools/` — MCP tool implementations
- `src/transcript/` — Transcript layer: db, parser, ingest, summarize, artifacts, session-edges
- `src/storage/` — Knowledge layer: Redis + SQLite dual-write
- `src/search/` — Hybrid search (RRF) + reranker (recency, type, graph degree, diversify)
- `src/embeddings/` — Ollama client (embeddings, merge, summarize)
- `hooks/` — 7 Claude Code hooks (session-start, user-prompt, stop, post-tool, pre-compact, post-compact, session-end)

## Development

- `make setup` — Install deps + start Docker + build + pull model
- `make start` — Start Redis + Ollama (Docker)
- `make build` — Build TypeScript
- `make test` — Run tests (68 tests, no Docker needed for transcript/search)
- `make dev` — Watch mode

## Requirements

- Node.js 20+
- Docker (Redis Stack + Ollama containers)
