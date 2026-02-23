#!/bin/bash
# hooks/session-start.sh
# Fires on SessionStart — injects recalled memories as context

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Recall recent project context
MEMORIES=$(cd "$SCRIPT_DIR" && node dist/cli.js recall "recent project context decisions and preferences" 2>/dev/null || true)

if [ -z "$MEMORIES" ] || [ "$MEMORIES" = "No relevant memories found." ]; then
  exit 0
fi

# Inject as additional context
jq -n --arg ctx "$MEMORIES" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("Memento — relevant memories from previous sessions:\n" + $ctx)
  }
}'
