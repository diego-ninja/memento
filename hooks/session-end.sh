#!/bin/bash
# hooks/session-end.sh
# Fires on SessionEnd — safety net for memory extraction

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$PROJECT_DIR" ] || [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Run extraction in background — don't block session exit
nohup bash -c "
  RECENT=\$(tail -200 '$TRANSCRIPT_PATH' 2>/dev/null || true)
  if [ -n \"\$RECENT\" ]; then
    echo \"\$RECENT\" | head -c 8000 > /tmp/memento-session-end.txt
    # Future: process with Ollama and store via CLI
  fi
" &>/dev/null &

exit 0
