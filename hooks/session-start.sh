#!/bin/bash
# hooks/session-start.sh
# Fires on SessionStart — injects core + contextual archival memories

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# 0. Maintain: degrade stale core memories
$CLI maintain 2>/dev/null || true

# 1. Core memories (always injected)
CORE=$($CLI core 2>/dev/null || true)

# 2. Contextual archival recall
CONTEXT=""
if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
  CONTEXT=$(head -20 "$PROJECT_DIR/CLAUDE.md" 2>/dev/null | tr '\n' ' ' | cut -c1-200)
fi
QUERY="key decisions, preferences and learnings for: ${CONTEXT:-this project}"
ARCHIVAL=$($CLI recall "$QUERY" 2>/dev/null || true)

# Build output
OUTPUT=""
if [ -n "$CORE" ] && [ "$CORE" != "No core memories." ]; then
  OUTPUT="== core ==\n${CORE}"
fi
if [ -n "$ARCHIVAL" ] && [ "$ARCHIVAL" != "No relevant memories found." ]; then
  if [ -n "$OUTPUT" ]; then
    OUTPUT="${OUTPUT}\n\n== recent ==\n${ARCHIVAL}"
  else
    OUTPUT="== recent ==\n${ARCHIVAL}"
  fi
fi

if [ -z "$OUTPUT" ]; then
  STATS=$($CLI stats 2>/dev/null || true)
  TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")
  echo "{\"total\":$TOTAL,\"recalled\":0,\"updated\":$(date +%s)}" > "$HOME/.memento-stats"
  exit 0
fi

# Count recalled lines
RECALLED=$(echo -e "$OUTPUT" | grep -c '|' || echo "0")

# Update stats
STATS=$($CLI stats 2>/dev/null || true)
TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")
echo "{\"total\":$TOTAL,\"recalled\":$RECALLED,\"updated\":$(date +%s)}" > "$HOME/.memento-stats"

# Inject as context
jq -n --arg ctx "$(echo -e "$OUTPUT")" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("Memento — relevant memories from previous sessions:\n" + $ctx)
  }
}'
