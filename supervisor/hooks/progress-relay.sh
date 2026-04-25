#!/bin/bash
# Claude Code PostToolUse hook: sends tool progress to Supervisor's HTTP relay.
# Called with JSON on stdin containing tool_name, tool_input, cwd, etc.
#
# Relay URL is read from a runtime-dir file keyed by the sanitised cwd, written
# by SessionManager.start (see supervisor/src/session/manager.ts
# relayUrlFilePath). Claude Code hooks don't inherit custom env vars, so we
# fall back to the filesystem. Layout (Issue #88):
#
#   ${XDG_RUNTIME_DIR:-/tmp}/claude-hub-supervisor/<sanitised-cwd>.relay-url
#
# where <sanitised-cwd> is the absolute cwd with the leading `/` stripped and
# the remaining `/` replaced by `_` (matches the TS helper exactly).
#
# Sends: { tool, message } where message is a short human-readable target
# extracted from tool_input (e.g., "pgrep -fl claude" for Bash).

INPUT=$(cat)
MAX_LEN=80

# Read cwd from hook JSON to find the relay URL file
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
if [ -z "$CWD" ]; then
  exit 0
fi

# Sanitise the cwd to match relayUrlFilePath() in manager.ts
SANITISED="${CWD#/}"
SANITISED="${SANITISED//\//_}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
RELAY_URL_FILE="${RUNTIME_DIR}/claude-hub-supervisor/${SANITISED}.relay-url"
if [ ! -f "$RELAY_URL_FILE" ]; then
  exit 0
fi

SUPERVISOR_RELAY_URL=$(cat "$RELAY_URL_FILE")
if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0
fi

THREAD_ID="${SUPERVISOR_RELAY_URL##*/relay/}"
if [ -z "$THREAD_ID" ]; then
  exit 0
fi

PROGRESS_URL="${SUPERVISOR_RELAY_URL/relay/progress}"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Extract a short target string per tool type.
case "$TOOL_NAME" in
  Bash)
    TARGET=$(echo "$INPUT" | jq -r '.tool_input.command // ""' | tr '\n' ' ' | tr -s ' ')
    ;;
  Read|Edit|Write|NotebookEdit)
    FP=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
    TARGET="${FP##*/}"
    ;;
  Glob)
    TARGET=$(echo "$INPUT" | jq -r '.tool_input.pattern // ""')
    ;;
  Grep)
    PAT=$(echo "$INPUT" | jq -r '.tool_input.pattern // ""')
    PATH_F=$(echo "$INPUT" | jq -r '.tool_input.path // .tool_input.glob // ""')
    if [ -n "$PATH_F" ]; then
      TARGET="$PAT ($PATH_F)"
    else
      TARGET="$PAT"
    fi
    ;;
  Agent|Task)
    DESC=$(echo "$INPUT" | jq -r '.tool_input.description // ""')
    SUB=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // ""')
    if [ -n "$DESC" ] && [ -n "$SUB" ]; then
      TARGET="[$SUB] $DESC"
    elif [ -n "$DESC" ]; then
      TARGET="$DESC"
    else
      TARGET="$SUB"
    fi
    ;;
  WebFetch)
    TARGET=$(echo "$INPUT" | jq -r '.tool_input.url // ""')
    ;;
  WebSearch)
    TARGET=$(echo "$INPUT" | jq -r '.tool_input.query // ""')
    ;;
  *)
    TARGET="(実行完了)"
    ;;
esac

# Truncate to keep Discord messages readable
if [ ${#TARGET} -gt $MAX_LEN ]; then
  TARGET="${TARGET:0:$MAX_LEN}…"
fi

# Skip if we have no useful target (don't spam Discord with bare tool names)
if [ -z "$TARGET" ]; then
  exit 0
fi

jq -n --arg tool "$TOOL_NAME" --arg message "$TARGET" \
  '{"tool": $tool, "message": $message}' | \
curl -s -X POST "$PROGRESS_URL" \
  -H "Content-Type: application/json" \
  -d @- \
  --max-time 3 \
  > /dev/null 2>&1

exit 0
