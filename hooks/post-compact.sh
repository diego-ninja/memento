#!/bin/bash
# hooks/post-compact.sh
# Fires on PostCompact — captures Claude Code's compact summary

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
COMPACT_SUMMARY=$(echo "$INPUT" | jq -r '.compact_summary // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$SESSION_ID" ] || [ -z "$COMPACT_SUMMARY" ] || [ -z "$CWD" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Store Claude's compact summary as a DAG node
$CLI store-compact-summary \
  --session "$SESSION_ID" \
  --summary "$COMPACT_SUMMARY" \
  2>/dev/null || true

exit 0
