#!/bin/bash
# hooks/pre-compact.sh
# Fires on PreCompact — extracts session summary before context is lost

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$PROJECT_DIR" ] || [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Extract last N lines of transcript for summary (avoid processing huge files)
RECENT=$(tail -100 "$TRANSCRIPT_PATH" 2>/dev/null || true)

if [ -z "$RECENT" ]; then
  exit 0
fi

# Use Ollama to generate a compact summary
SUMMARY=$(echo "$RECENT" | curl -sf http://localhost:11435/api/generate \
  -d "$(jq -n --arg prompt "Summarize this development session transcript in 2-3 sentences. Focus on: what was built, key decisions made, and any issues encountered. Be concise.\n\nTranscript:\n$(echo "$RECENT" | head -c 4000)" \
  '{model: "nomic-embed-text", prompt: $prompt, stream: false}')" 2>/dev/null \
  | jq -r '.response // empty' 2>/dev/null || true)

# If Ollama summarization fails, create a basic timestamp entry
if [ -z "$SUMMARY" ]; then
  SUMMARY="Session compacted at $(date -u +%Y-%m-%dT%H:%M:%SZ) in project $PROJECT_DIR"
fi

# For now, just exit cleanly — the MCP remember tool handles storage during session
exit 0
