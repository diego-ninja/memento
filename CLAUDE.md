# Memento

Persistent memory system for LLMs via MCP Server + Claude Code hooks.

## Project Structure

- `src/server.ts` — MCP server entry point
- `src/cli.ts` — CLI for hooks and manual use
- `src/tools/` — MCP tools (recall, remember, remember_extract)
- `src/storage/` — Redis + SQLite dual-write storage
- `src/search/` — Hybrid search + reranker
- `src/embeddings/` — Ollama embedding client
- `hooks/` — Claude Code hook scripts

## Development

- `make setup` — Install all dependencies
- `make start` — Start Redis + Ollama (Docker)
- `make build` — Build TypeScript
- `make test` — Run tests
- `make dev` — Watch mode

## Requirements

- Node.js 20+
- Docker (Redis Stack + Ollama containers)
