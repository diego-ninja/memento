#!/bin/bash
# hooks/session-end.sh
# Fires on SessionEnd — batch ingest transcript, extract memories, build DAG async

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# 1. Batch ingest full transcript (fills gaps from real-time hooks)
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  $CLI ingest-transcript --session "${SESSION_ID:-session-$(date +%s)}" --path "$TRANSCRIPT_PATH" 2>/dev/null || true
fi

# 2. Extract knowledge memories from transcript
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  $CLI extract "$TRANSCRIPT_PATH" 2>/dev/null || true
fi

# 3. Detect artifacts from tool calls
if [ -n "$SESSION_ID" ]; then
  $CLI detect-artifacts --session "$SESSION_ID" 2>/dev/null || true
fi

# 4. Link sessions (detect continuations)
$CLI link-sessions 2>/dev/null || true

# 5. Build summary DAG (async — may take 10-30s with Ollama)
if [ -n "$SESSION_ID" ]; then
  $CLI build-dag --session "$SESSION_ID" 2>/dev/null &
fi

# 4. Update stats
STATS=$($CLI stats 2>/dev/null || true)
TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")

if [ -f "$HOME/.memento-stats" ]; then
  PREV_RECALLED=$(grep -o '"recalled":[0-9]*' "$HOME/.memento-stats" | cut -d: -f2)
else
  PREV_RECALLED=0
fi
echo "{\"total\":$TOTAL,\"recalled\":${PREV_RECALLED:-0},\"updated\":$(date +%s)}" > "$HOME/.memento-stats"

exit 0
