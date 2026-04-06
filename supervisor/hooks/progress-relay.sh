#!/bin/bash
# Claude Code PostToolUse hook: sends tool progress to Supervisor's HTTP relay.
# Called with JSON on stdin containing tool_name, tool_input, etc.
# Requires: SUPERVISOR_RELAY_URL environment variable (e.g., http://localhost:PORT/relay/THREAD_ID).

if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0
fi

# Extract thread ID from relay URL: http://localhost:PORT/relay/THREAD_ID
THREAD_ID="${SUPERVISOR_RELAY_URL##*/relay/}"
if [ -z "$THREAD_ID" ]; then
  exit 0
fi

# Build progress URL from relay URL
PROGRESS_URL="${SUPERVISOR_RELAY_URL/\/relay\//\/progress\/}"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Skip noisy tools to avoid spamming Discord
case "$TOOL_NAME" in
  Read|Glob|Grep|Bash)
    MESSAGE="実行完了"
    ;;
  Write|Edit)
    MESSAGE="ファイル更新"
    ;;
  Agent)
    MESSAGE="サブエージェント実行中"
    ;;
  *)
    MESSAGE="実行完了"
    ;;
esac

jq -n --arg tool "$TOOL_NAME" --arg message "$MESSAGE" \
  '{"tool": $tool, "message": $message}' | \
curl -s -X POST "$PROGRESS_URL" \
  -H "Content-Type: application/json" \
  -d @- \
  --max-time 3 \
  > /dev/null 2>&1

exit 0
