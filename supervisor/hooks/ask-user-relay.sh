#!/bin/bash
# Claude Code PreToolUse hook (matcher: AskUserQuestion). Issue #12 Phase 1.
#
# Forwards an AskUserQuestion prompt from a headless supervisor session to the
# Discord thread, waits for the user's reply, and injects the reply back into
# the tool call via PreToolUse `updatedInput` so Claude continues without
# blocking on a TUI dialog.
#
# Skipping behaviour
# ------------------
# Out of a supervisor session (no relay-url file for the cwd), the hook exits
# 0 silently with no stdout — Claude sees the original tool input unchanged
# and the regular TUI dialog flow runs (Issue #12 AC-3 / Journey-AC #3).
#
# Relay URL discovery mirrors `progress-relay.sh`: the runtime-dir layout is
# written by SessionManager.start (`relayUrlFilePath()` in manager.ts).
#
#   $XDG_RUNTIME_DIR set: ${XDG_RUNTIME_DIR}/claude-hub-supervisor/<sanitised-cwd>.relay-url
#   $XDG_RUNTIME_DIR unset (typical macOS): /tmp/claude-hub-supervisor-<USER>/<sanitised-cwd>.relay-url

INPUT=$(cat)

# Read cwd from hook JSON. Without a cwd we have no way to find the relay URL.
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
if [ -z "$CWD" ]; then
  exit 0
fi

# Sanitise the cwd to match relayUrlFilePath() in manager.ts:
#   - strip ALL leading slashes
#   - replace any non-[A-Za-z0-9._-] with `_`
SANITISED=$(printf '%s' "$CWD" | sed -e 's|^/*||' -e 's|[^A-Za-z0-9._-]|_|g')
if [ -n "$XDG_RUNTIME_DIR" ]; then
  RUNTIME_DIR="${XDG_RUNTIME_DIR}/claude-hub-supervisor"
else
  RUNTIME_DIR="/tmp/claude-hub-supervisor-${USER:-default}"
fi
RELAY_URL_FILE="${RUNTIME_DIR}/${SANITISED}.relay-url"
if [ ! -f "$RELAY_URL_FILE" ]; then
  # Not running under a supervisor session — keep TUI behaviour unchanged.
  exit 0
fi

SUPERVISOR_RELAY_URL=$(cat "$RELAY_URL_FILE")
if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0
fi

# Derive the /ask/ endpoint from the /relay/ URL the manager wrote. Use sed
# to scope the substitution to the path segment `/relay/` only — bash's
# `${VAR/pat/repl}` replaces the FIRST `relay` anywhere in the URL, which would
# corrupt host names or threadIds containing the literal "relay" (review:
# gemini-code-assist on PR #142, comment 3179491537).
ASK_URL=$(printf '%s' "$SUPERVISOR_RELAY_URL" | sed 's|/relay/|/ask/|')

# Extract the question Claude wants to ask. AskUserQuestion's input shape is
# `{ "question": "..." }`. Some flavours nest it under `prompt`, so accept
# either; on the way out we always send `question` to the relay-server.
QUESTION=$(echo "$INPUT" | jq -r '.tool_input.question // .tool_input.prompt // ""')
if [ -z "$QUESTION" ]; then
  # Nothing useful to forward — let Claude proceed with its original input.
  exit 0
fi

# Forward to the supervisor and wait for the user's reply. --max-time matches
# the relay-server's DEFAULT_ASK_TIMEOUT_MS plus a small buffer for the round
# trip; the server itself enforces the real timeout.
RESPONSE=$(jq -n --arg q "$QUESTION" '{question: $q}' | \
  curl -s -X POST "$ASK_URL" \
    -H "Content-Type: application/json" \
    -d @- \
    --max-time 130)
CURL_EXIT=$?

if [ $CURL_EXIT -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Network / supervisor failure: don't block Claude. Letting the original
  # AskUserQuestion run is safer than synthesising a fake answer.
  exit 0
fi

ANSWER=$(echo "$RESPONSE" | jq -r '.answer // ""' 2>/dev/null)
if [ -z "$ANSWER" ]; then
  # 504 / 499 / malformed body — fall back to TUI behaviour.
  exit 0
fi

# Inject the reply via PreToolUse `updatedInput`. Claude consumes this as the
# new tool_input, so AskUserQuestion completes synchronously with the user's
# reply and Claude continues on the next turn.
jq -n --arg answer "$ANSWER" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: {
      question: $answer
    }
  }
}'
