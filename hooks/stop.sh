#!/bin/bash
# hooks/stop.sh
# Fires on Stop — captures Claude's response to immutable store

set -euo pipefail

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$MESSAGE" ] || [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Fire-and-forget: persist assistant message
$CLI ingest-message \
  --session "$SESSION_ID" \
  --role assistant \
  --content "$MESSAGE" \
  2>/dev/null &

exit 0
