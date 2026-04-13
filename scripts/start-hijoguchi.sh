#!/bin/bash
# claudeHubExit watchdog — keeps a tmux session named 'claudeHubExit' alive
# running `claude --channels plugin:discord@claude-plugins-official`.
#
# Invoked by launchd (com.claude-hub.hijoguchi). Exits only on SIGTERM
# from launchd; on any Claude crash, restarts the tmux session after a short
# backoff. launchd KeepAlive restarts this script if it dies entirely.
#
# See docs/bot-operations.md for rationale.

set -u

SESSION=claudeHubExit
CLAUDE_HUB_DIR="$HOME/claude-hub"
LOG_DIR="$CLAUDE_HUB_DIR/logs"
CLAUDE_BIN="$HOME/.local/bin/claude"
TMUX_BIN="/opt/homebrew/bin/tmux"
BACKOFF_SEC=5

mkdir -p "$LOG_DIR"

# Clean shutdown on SIGTERM from launchd
trap 'echo "[hijoguchi] SIGTERM received, killing tmux session"; "$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null; exit 0' TERM INT

echo "[hijoguchi] watchdog starting at $(date)"

while true; do
  # Ensure no stale session
  "$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null

  echo "[hijoguchi] starting tmux session '$SESSION' at $(date)"
  "$TMUX_BIN" new-session -d -s "$SESSION" -c "$CLAUDE_HUB_DIR" \
    "$CLAUDE_BIN --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"

  # Block while the session exists
  while "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; do
    sleep 10
  done

  echo "[hijoguchi] session '$SESSION' ended at $(date), backing off ${BACKOFF_SEC}s"
  sleep "$BACKOFF_SEC"
done
