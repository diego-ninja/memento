.PHONY: setup install-ollama install-redis start stop status build dev test clean

# ── Setup ───────────────────────────────────────────────
setup: install-ollama install-redis
	npm install
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

install-redis:
	@if ! command -v redis-server &> /dev/null; then \
		echo "Installing Redis Stack (includes RediSearch)..."; \
		brew tap redis-stack/redis-stack; \
		brew install redis-stack; \
	else \
		echo "Redis already installed"; \
	fi

# ── Services ────────────────────────────────────────────
start:
	@echo "Starting Redis Stack..."
	@redis-stack-server --daemonize yes 2>/dev/null || redis-server --daemonize yes --loadmodule $$(brew --prefix)/lib/rejson.so --loadmodule $$(brew --prefix)/lib/redisearch.so 2>/dev/null || echo "Redis might already be running"
	@echo "Starting Ollama..."
	@ollama serve &>/dev/null & disown 2>/dev/null || echo "Ollama might already be running"
	@sleep 1
	@make status

stop:
	@echo "Stopping Redis..."
	@redis-cli shutdown 2>/dev/null || echo "Redis not running"
	@echo "Stopping Ollama..."
	@pkill -f "ollama serve" 2>/dev/null || echo "Ollama not running"
	@echo "Services stopped."

status:
	@echo "── Service Status ──"
	@redis-cli ping 2>/dev/null && echo "Redis:  ✔ running" || echo "Redis:  ✘ stopped"
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
