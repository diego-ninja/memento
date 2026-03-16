#!/bin/bash
# hooks/session-start.sh
# Fires on SessionStart — injects core memories, session summaries, and recovery context

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# 0. Maintain: degrade stale core memories
$CLI maintain 2>/dev/null || true

if [ "$SOURCE" = "compact" ]; then
  # ===== POST-COMPACTION RECOVERY =====

  # 1. Our DAG/checkpoint summary (richer than Claude Code's compact)
  DAG_SUMMARY=$($CLI session-summary --session "$SESSION_ID" 2>/dev/null || true)

  # 2. Core memories
  CORE=$($CLI core 2>/dev/null || true)

  OUTPUT=""
  if [ -n "$DAG_SUMMARY" ] && [ "$DAG_SUMMARY" != "No summary available." ]; then
    OUTPUT="== session context (recovered from compaction) ==\n${DAG_SUMMARY}"
  fi
  if [ -n "$CORE" ] && [ "$CORE" != "No core memories." ]; then
    OUTPUT="${OUTPUT}\n\n== core ==\n${CORE}"
  fi
  OUTPUT="${OUTPUT}\n\n== recovery tools ==\ntranscript_grep(pattern) — search full session history\ntranscript_expand(id) — recover original messages from any summary\nremember() — persist key decisions/learnings"

  jq -n --arg ctx "$(echo -e "$OUTPUT")" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ("Memento — post-compaction context recovery:\n" + $ctx)
    }
  }'

else
  # ===== NORMAL STARTUP =====

  # 1. Core memories
  CORE=$($CLI core 2>/dev/null || true)

  # 2. Recent session summaries (from DAG roots)
  SESSIONS=$($CLI sessions --recent 3 --format summary 2>/dev/null || true)

  # 3. Contextual archival recall
  CONTEXT=""
  if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
    CONTEXT=$(head -20 "$PROJECT_DIR/CLAUDE.md" 2>/dev/null | tr '\n' ' ' | cut -c1-200)
  fi
  QUERY="key decisions, preferences and learnings for: ${CONTEXT:-this project}"
  ARCHIVAL=$($CLI recall "$QUERY" 2>/dev/null || true)

  OUTPUT=""
  if [ -n "$CORE" ] && [ "$CORE" != "No core memories." ]; then
    OUTPUT="== core ==\n${CORE}"
  fi
  if [ -n "$SESSIONS" ] && [ "$SESSIONS" != "No recent sessions." ]; then
    OUTPUT="${OUTPUT}\n\n== recent sessions ==\n${SESSIONS}"
  fi
  if [ -n "$ARCHIVAL" ] && [ "$ARCHIVAL" != "No relevant memories found." ]; then
    OUTPUT="${OUTPUT}\n\n== relevant ==\n${ARCHIVAL}"
  fi

  if [ -z "$OUTPUT" ]; then
    STATS=$($CLI stats 2>/dev/null || true)
    TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")
    echo "{\"total\":$TOTAL,\"recalled\":0,\"updated\":$(date +%s)}" > "$HOME/.memento-stats"
    exit 0
  fi

  RECALLED=$(echo -e "$OUTPUT" | grep -c '|' || echo "0")
  STATS=$($CLI stats 2>/dev/null || true)
  TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")
  echo "{\"total\":$TOTAL,\"recalled\":$RECALLED,\"updated\":$(date +%s)}" > "$HOME/.memento-stats"

  jq -n --arg ctx "$(echo -e "$OUTPUT")" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ("Memento — relevant memories from previous sessions:\n" + $ctx)
    }
  }'
fi
