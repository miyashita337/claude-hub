#!/bin/bash
# Claude Code Stop hook: POSTs the assistant response to Supervisor's HTTP relay.
# Called with JSON on stdin containing last_assistant_message, session_id, and
# (Claude Code contract) transcript_path.
# Requires: SUPERVISOR_RELAY_URL environment variable.
#
# Issue #204: also computes the session's *current* context token count from the
# transcript and forwards it as `context_tokens`. At high context (~330k+) a
# session's tool-call markup can degrade to plain text and the tool silently
# never runs (context rot); the supervisor uses this number to warn the Discord
# thread before/when the session enters rot territory. Best-effort: if the
# transcript or jq is unavailable, the field is simply omitted (the response
# POST must never break on instrumentation).

if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0
fi

INPUT=$(cat)
TEXT=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$TEXT" ]; then
  exit 0
fi

# --- Issue #204: context token count (best-effort) ---------------------------
# Mirrors agent-base hooks/context-budget-check.sh: the *current* context size
# is the last usage entry's input_tokens + cache_read + cache_creation (summing
# the whole session would double-count cache re-reads). Only the tail of the
# transcript is scanned so cost stays bounded even when the file is large — and
# a large file is exactly the high-context case we care about.
CONTEXT_TOKENS=""
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  CONTEXT_TOKENS=$(tail -n 400 "$TRANSCRIPT" 2>/dev/null \
    | grep '"usage"' 2>/dev/null \
    | jq -c -R 'fromjson? // empty' 2>/dev/null \
    | jq -s -r '
        [ .[] | select(.message.usage) ] as $u
        | if ($u | length) == 0 then empty
          else ($u[-1].message.usage) as $x
            | ( ($x.input_tokens // 0)
              + ($x.cache_read_input_tokens // 0)
              + ($x.cache_creation_input_tokens // 0) )
          end
      ' 2>/dev/null)
fi
# Accept only a plain non-negative integer; anything else → omit the field.
case "$CONTEXT_TOKENS" in
  '' | *[!0-9]*) CONTEXT_TOKENS="" ;;
esac

if [ -n "$CONTEXT_TOKENS" ]; then
  PAYLOAD=$(jq -n --arg text "$TEXT" --arg sid "$SESSION_ID" --argjson ctx "$CONTEXT_TOKENS" \
    '{text: $text, session_id: $sid, context_tokens: $ctx}')
else
  PAYLOAD=$(jq -n --arg text "$TEXT" --arg sid "$SESSION_ID" \
    '{text: $text, session_id: $sid}')
fi

curl -s -X POST "$SUPERVISOR_RELAY_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 5 \
  > /dev/null 2>&1

exit 0
