#!/bin/bash
# claude-mock.sh — fake `claude` CLI for the Discord lifecycle E2E (Issue #144).
#
# Reads newline-delimited input from stdin. For each non-empty line:
#   1. Echoes a reply to stdout (visible to tmux capture-pane).
#   2. POSTs {text, session_id} to $SUPERVISOR_RELAY_URL to simulate Claude's
#      Stop hook (mirrors hooks/stop-relay.sh's contract).
#
# Env:
#   SUPERVISOR_RELAY_URL          Relay POST endpoint. Optional; if unset,
#                                 only stdout echo runs (useful for offline test).
#   CLAUDE_MOCK_SESSION_ID        Defaults to "mock-session-$$".
#   CLAUDE_MOCK_REPLY_TEMPLATE    printf format with single %s. Defaults to
#                                 "[mock-claude] received: %s".
#   CLAUDE_MOCK_CURL_TIMEOUT      Curl --max-time seconds. Default 5.
#
# Exits 0 on EOF (Ctrl-D / pipe close).

set -u

SESSION_ID="${CLAUDE_MOCK_SESSION_ID:-mock-session-$$}"
TEMPLATE="${CLAUDE_MOCK_REPLY_TEMPLATE:-[mock-claude] received: %s}"
CURL_TIMEOUT="${CLAUDE_MOCK_CURL_TIMEOUT:-5}"

# json_escape <text>
# Emits a JSON-quoted string. Prefers jq when available for correctness;
# falls back to a minimal sed escaper if jq is missing on the runner.
json_escape() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs .
  else
    printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g')"
  fi
}

while IFS= read -r line; do
  # Skip empty lines but keep loop alive.
  [ -z "$line" ] && continue

  # Build reply by splitting TEMPLATE on the first %s and concatenating
  # the literal halves around $line. This avoids passing TEMPLATE to
  # printf as a format string, sidestepping format-directive injection
  # if the env var is ever sourced from untrusted input. TEMPLATE
  # without a %s simply emits its literal contents.
  if [[ "$TEMPLATE" == *"%s"* ]]; then
    prefix="${TEMPLATE%%%s*}"
    suffix="${TEMPLATE#*%s}"
    reply="${prefix}${line}${suffix}"
  else
    reply="$TEMPLATE"
  fi
  printf '%s\n' "$reply"

  # Best-effort Stop hook simulation. Failure is non-fatal so test runners
  # without network access still observe the stdout echo.
  if [ -n "${SUPERVISOR_RELAY_URL:-}" ]; then
    text_json=$(json_escape "$reply")
    sid_json=$(json_escape "$SESSION_ID")
    payload="{\"text\":${text_json},\"session_id\":${sid_json}}"
    curl -s -X POST "$SUPERVISOR_RELAY_URL" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      --max-time "$CURL_TIMEOUT" \
      >/dev/null 2>&1 || true
  fi
done

exit 0
