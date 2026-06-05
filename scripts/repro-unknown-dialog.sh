#!/bin/bash
# Issue #12 (Journey AC #2): reproduce an "unknown dialog" stall for manual
# verification of the dialog-stuck heartbeat path.
#
# The dialog watchdog (supervisor/src/session/dialog-watchdog.ts) only fires
# for *known* dialog families. This script starts a tmux pane (on the
# supervisor's `-L claude-hub` socket, per CLAUDE.md) showing a prompt that
# `detectDialog` does NOT match, then blocks forever. A relay against this
# session never receives a Stop-hook response, so the stall timer
# (stall-heartbeat.ts) is the only thing that pages the user.
#
# Usage:
#   bash scripts/repro-unknown-dialog.sh start   # create the stuck pane
#   bash scripts/repro-unknown-dialog.sh stop    # kill it
#
# After `start`, relay a message to the matching thread and confirm:
#   - a "⚠️ Claude Code が応答待ちでブロック中" heartbeat appears in the
#     Discord thread within the stall threshold (default 3 min), including the
#     tmux session name printed below, and
#   - a Pushover push arrives (if PUSHOVER_TOKEN / PUSHOVER_USER_KEY are set).
set -euo pipefail

SOCKET="${SUPERVISOR_TMUX_SOCKET:-claude-hub}"
# Allow `start <name>` / `stop <name>`; default session name otherwise.
ACTION="${1:-start}"
SESSION_NAME="${2:-claude-repro-unknown-dialog}"

usage() {
  echo "Usage: $0 {start|stop} [session-name]" >&2
  exit 2
}

case "$ACTION" in
  start)
    if tmux -L "$SOCKET" has-session -t "$SESSION_NAME" 2>/dev/null; then
      echo "[repro] session '$SESSION_NAME' already exists on socket '$SOCKET'." >&2
    else
      # A made-up prompt that none of the DialogKind matchers recognise.
      # `read -r` blocks forever (no stdin), so the pane never resolves.
      tmux -L "$SOCKET" new-session -d -s "$SESSION_NAME" \
        "printf '\\n=== UNKNOWN CUSTOM DIALOG (repro #12) ===\\nEnter the secret passphrase to continue:\\n> '; read -r _; sleep 86400"
      echo "[repro] started stuck pane."
    fi
    echo "[repro] socket : $SOCKET"
    echo "[repro] session: $SESSION_NAME"
    echo "[repro] attach : tmux -L $SOCKET attach -t $SESSION_NAME"
    echo "[repro] verify : relay a message to this thread; expect a stall heartbeat + Pushover."
    ;;
  stop)
    if tmux -L "$SOCKET" has-session -t "$SESSION_NAME" 2>/dev/null; then
      tmux -L "$SOCKET" kill-session -t "$SESSION_NAME"
      echo "[repro] killed session '$SESSION_NAME'."
    else
      echo "[repro] no session '$SESSION_NAME' on socket '$SOCKET'." >&2
    fi
    ;;
  *)
    usage
    ;;
esac
