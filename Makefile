.PHONY: help setup start stop status build dev test clean
.PHONY: recall stats hydrate core maintain flush
.PHONY: sessions ingest-transcript build-dag detect-artifacts link-sessions
.DEFAULT_GOAL := help

COMPOSE := docker compose
CLI := node dist/cli.js

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Setup ───────────────────────────────────────────────
setup: ## Install deps, start infrastructure, build, pull model
	npm install
	$(COMPOSE) up -d
	npx tsc
	@echo "Pulling Ollama model..."
	@docker exec memento-ollama-1 ollama pull nomic-embed-text 2>/dev/null || echo "Pull model manually: docker exec <ollama-container> ollama pull nomic-embed-text"
	@echo "Done. Run 'make start' to verify."

# ── Infrastructure ─────────────────────────────────────
start: ## Start Redis + Ollama (Docker) and hydrate Redis
	@$(COMPOSE) up -d
	@make status
	@$(CLI) hydrate 2>/dev/null || echo "Hydrate skipped (run 'make build' first)"

stop: ## Stop infrastructure
	@$(COMPOSE) down

status: ## Show service status
	@echo "── Infrastructure ──"
	@$(COMPOSE) ps --format '{{.Service}}: {{.Status}}' 2>/dev/null || echo "No services running"

# ── Build ──────────────────────────────────────────────
build: ## Build TypeScript
	npx tsc

dev: ## Watch mode
	npx tsc --watch

# ── Test ───────────────────────────────────────────────
test: ## Run tests (no Docker required for transcript/search tests)
	npx vitest run

test-watch: ## Run tests in watch mode
	npx vitest

# ── Knowledge Layer CLI ────────────────────────────────
recall: ## Search memories (ARGS="query")
	@$(CLI) recall $(ARGS)

stats: ## Show memory stats
	@$(CLI) stats

core: ## Show core memories
	@$(CLI) core

maintain: ## Degrade stale core memories
	@$(CLI) maintain

hydrate: ## Reload Redis search index from SQLite
	@$(CLI) hydrate

flush: ## Delete ALL memories (with confirmation)
	@echo "This will delete ALL memories. Press Ctrl+C to cancel."
	@sleep 3
	@$(CLI) flush

# ── Transcript Layer CLI ───────────────────────────────
sessions: ## List recent sessions (ARGS="--recent 5")
	@$(CLI) sessions $(ARGS)

ingest-transcript: ## Batch ingest a transcript (ARGS="--session <id> --path <file>")
	@$(CLI) ingest-transcript $(ARGS)

build-dag: ## Build summary DAG for a session (ARGS="--session <id>")
	@$(CLI) build-dag $(ARGS)

detect-artifacts: ## Detect file artifacts in a session (ARGS="--session <id>")
	@$(CLI) detect-artifacts $(ARGS)

link-sessions: ## Create edges between related sessions
	@$(CLI) link-sessions

# ── Clean ──────────────────────────────────────────────
clean: ## Remove dist/
	rm -rf dist/
