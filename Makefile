.PHONY: help setup start stop status build dev test clean recall stats flush hydrate core maintain
.DEFAULT_GOAL := help

COMPOSE := docker compose
CLI := node dist/cli.js

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ── Setup ───────────────────────────────────────────────
setup: ## Install deps, start services, build
	npm install
	$(COMPOSE) up -d
	npx tsc
	@echo "✔ Memento setup complete. Run 'make start' to launch services."

# ── Services ────────────────────────────────────────────
start: ## Start infrastructure (Redis + Ollama) + hydrate
	@$(COMPOSE) up -d
	@make status
	@echo "Hydrating Redis..."
	@$(CLI) hydrate 2>/dev/null || echo "Hydrate skipped (build first)"

stop: ## Stop all services
	@echo "Stopping services..."
	@$(COMPOSE) down
	@echo "Services stopped."

status: ## Show service status
	@echo "── Service Status ──"
	@$(COMPOSE) ps --format '{{.Service}}: {{.Status}}' 2>/dev/null || echo "No services running"
	@echo ""

# ── Build ──────────────────────────────────────────────
build: ## Build TypeScript
	npx tsc

dev: ## Watch mode
	npx tsc --watch

# ── Test ────────────────────────────────────────────────
test: ## Run tests
	npx vitest run

test-watch: ## Run tests in watch mode
	npx vitest

# ── Clean ───────────────────────────────────────────────
clean: ## Remove dist/
	rm -rf dist/

# ── Memento CLI ────────────────────────────────────────
recall: ## Recall memories (ARGS="query")
	@$(CLI) recall $(ARGS)

stats: ## Show memory stats
	@$(CLI) stats

hydrate: ## Hydrate Redis from SQLite
	@$(CLI) hydrate

core: ## Show core memories
	@$(CLI) core

maintain: ## Run maintenance (degrade stale core memories)
	@$(CLI) maintain

flush: ## Delete ALL memories
	@echo "⚠ This will delete ALL memories. Press Ctrl+C to cancel."
	@sleep 3
	@$(CLI) flush
