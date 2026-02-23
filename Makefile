.PHONY: setup install-ollama start stop status build dev test clean

REDIS_PORT := 6380

# ── Setup ───────────────────────────────────────────────
setup: install-ollama
	npm install
	docker compose up -d
	@echo "✔ Memento setup complete. Run 'make start' to launch services."

install-ollama:
	@if ! command -v ollama &> /dev/null; then \
		echo "Installing Ollama..."; \
		brew install ollama; \
	else \
		echo "Ollama already installed"; \
	fi
	@echo "Pulling nomic-embed-text model..."
	ollama pull nomic-embed-text

# ── Services ────────────────────────────────────────────
start:
	@echo "Starting Redis Stack (docker)..."
	@docker compose up -d
	@echo "Starting Ollama..."
	@ollama serve &>/dev/null & disown 2>/dev/null || echo "Ollama might already be running"
	@sleep 1
	@make status

stop:
	@echo "Stopping Redis (docker)..."
	@docker compose down
	@echo "Stopping Ollama..."
	@pkill -f "ollama serve" 2>/dev/null || echo "Ollama not running"
	@echo "Services stopped."

status:
	@echo "── Service Status ──"
	@docker compose ps --format '{{.Service}}: {{.Status}}' 2>/dev/null | grep redis || echo "Redis:  ✘ stopped"
	@curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 && echo "Ollama: ✔ running" || echo "Ollama: ✘ stopped"
	@echo ""

# ── Build ───────────────────────────────────────────────
build:
	npx tsc

dev:
	npx tsc --watch

# ── Test ────────────────────────────────────────────────
test:
	npx vitest run

test-watch:
	npx vitest

# ── Clean ───────────────────────────────────────────────
clean:
	rm -rf dist/

# ── Memento CLI ─────────────────────────────────────────
recall:
	@node dist/cli.js recall $(ARGS)

stats:
	@node dist/cli.js stats

flush:
	@echo "⚠ This will delete ALL memories. Press Ctrl+C to cancel."
	@sleep 3
	@node dist/cli.js flush
