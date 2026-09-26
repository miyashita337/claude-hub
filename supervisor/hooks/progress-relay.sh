#!/bin/bash
# Claude Code PostToolUse hook: sends tool progress to Supervisor's HTTP relay.
# Called with JSON on stdin containing tool_name, tool_input, session_id, etc.
#
# Relay URL discovery (Issue #149/#150):
#
#   1. Primary: $SUPERVISOR_RELAY_URL, exported directly into this session's
#      environment by SessionManager.launchStart/launchResume (manager.ts).
#      Per-process env, so it can never collide across sessions the way a
#      shared file can.
#   2. Fallback (older Claude Code / non-standard invocation that does not
#      propagate the exported env into hook subprocesses): a runtime-dir file
#      written by the SAME manager.ts call, keyed by THIS hook invocation's
#      `session_id` — NOT the cwd. Two Discord threads commonly share a
#      projectDir (one repo, several logical threads); keying by cwd made
#      them collide on one file, so the last-started thread's URL silently
#      overwrote every other thread's (#149/#150). `session_id` is the
#      per-conversation `claudeSessionId` and is unique per concurrently
#      running session, so this cannot collide even across identical cwds.
#      Layout:
#        $XDG_RUNTIME_DIR set: ${XDG_RUNTIME_DIR}/claude-hub-supervisor/<sanitised-session-id>.relay-url
#        $XDG_RUNTIME_DIR unset (typical macOS): /tmp/claude-hub-supervisor-<USER>/<sanitised-session-id>.relay-url
#      <sanitised-session-id> strips all leading `/` and replaces any
#      non-`[A-Za-z0-9._-]` character with `_` — a no-op for a UUID, but this
#      must match `relayUrlFilePath()` in manager.ts exactly.
#
# Sends: { tool, message } where message is a short human-readable target
# extracted from tool_input (e.g., "pgrep -fl claude" for Bash).

INPUT=$(cat)
MAX_LEN=80

if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
  if [ -z "$SESSION_ID" ]; then
    exit 0
  fi
  SANITISED=$(printf '%s' "$SESSION_ID" | sed -e 's|^/*||' -e 's|[^A-Za-z0-9._-]|_|g')
  if [ -n "$XDG_RUNTIME_DIR" ]; then
    RUNTIME_DIR="${XDG_RUNTIME_DIR}/claude-hub-supervisor"
  else
    RUNTIME_DIR="/tmp/claude-hub-supervisor-${USER:-default}"
  fi
  RELAY_URL_FILE="${RUNTIME_DIR}/${SANITISED}.relay-url"
  if [ ! -f "$RELAY_URL_FILE" ]; then
    exit 0
  fi
  SUPERVISOR_RELAY_URL=$(cat "$RELAY_URL_FILE")
  if [ -z "$SUPERVISOR_RELAY_URL" ]; then
    exit 0
  fi
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
