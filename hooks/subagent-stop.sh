#!/bin/bash
# hooks/subagent-stop.sh
# Fires on SubagentStop — ingests sub-agent transcript into immutable store

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')
AGENT_TRANSCRIPT=$(echo "$INPUT" | jq -r '.agent_transcript_path // empty')
LAST_MESSAGE=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# 1. Ingest sub-agent transcript if available
if [ -n "$AGENT_TRANSCRIPT" ] && [ -f "$AGENT_TRANSCRIPT" ]; then
  SUBAGENT_SESSION="${SESSION_ID}:${AGENT_ID:-${AGENT_TYPE:-sub}}"
  $CLI ingest-transcript \
    --session "$SUBAGENT_SESSION" \
    --path "$AGENT_TRANSCRIPT" \
    2>/dev/null &
fi

# 2. Also persist the final message in the parent session as a tool_result
if [ -n "$LAST_MESSAGE" ]; then
  CONTENT="[SubAgent:${AGENT_TYPE:-unknown}] ${LAST_MESSAGE}"
  $CLI ingest-message \
    --session "$SESSION_ID" \
    --role tool_result \
    --content "$CONTENT" \
    2>/dev/null &
fi

exit 0
