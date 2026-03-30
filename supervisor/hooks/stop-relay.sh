#!/bin/bash
# Claude Code Stop hook: POSTs the assistant response to Supervisor's HTTP relay.
# Called with JSON on stdin containing last_assistant_message and session_id.
# Requires: SUPERVISOR_RELAY_URL environment variable.

if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0
fi

INPUT=$(cat)
TEXT=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$TEXT" ]; then
  exit 0
fi

curl -s -X POST "$SUPERVISOR_RELAY_URL" \
  -H "Content-Type: application/json" \
  -d "{\"text\": $(echo "$TEXT" | jq -Rs .), \"session_id\": \"$SESSION_ID\"}" \
  --max-time 5 \
  > /dev/null 2>&1

exit 0
