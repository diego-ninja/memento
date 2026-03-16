#!/bin/bash
# hooks/pre-compact.sh
# Fires on PreCompact — generates session checkpoint and injects as context

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Generate checkpoint summary from ingested messages
SUMMARY=$($CLI checkpoint --session "$SESSION_ID" 2>/dev/null || true)

if [ -n "$SUMMARY" ] && [ "$SUMMARY" != "No messages to summarize." ]; then
  jq -n --arg ctx "$SUMMARY" '{
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext: $ctx
    }
  }'
else
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext: "MEMENTO: persist key memories via remember() before compaction."
    }
  }'
fi
