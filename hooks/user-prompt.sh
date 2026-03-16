#!/bin/bash
# hooks/user-prompt.sh
# Fires on UserPromptSubmit — captures user prompts to immutable store

set -euo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$PROMPT" ] || [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Fire-and-forget: persist user message
$CLI ingest-message \
  --session "$SESSION_ID" \
  --role user \
  --content "$PROMPT" \
  2>/dev/null &

exit 0
