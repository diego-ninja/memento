#!/bin/bash
# hooks/post-tool.sh
# Fires on PostToolUse — captures tool calls and results to immutable store

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$SESSION_ID" ] || [ -z "$CWD" ] || [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# Only track substantive tools, skip internal/noisy ones
case "$TOOL_NAME" in
  Read|Write|Edit|Bash|Grep|Glob|WebFetch|WebSearch|Agent)
    ;;
  recall|remember|transcript_grep|transcript_expand|transcript_describe)
    ;;
  *)
    # Skip MCP internal tools, progress hooks, etc.
    exit 0
    ;;
esac

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Build compact tool call summary
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' | cut -c1-2000)
CONTENT="[$TOOL_NAME] $TOOL_INPUT"

# Fire-and-forget
$CLI ingest-message \
  --session "$SESSION_ID" \
  --role tool_call \
  --content "$CONTENT" \
  2>/dev/null &

exit 0
