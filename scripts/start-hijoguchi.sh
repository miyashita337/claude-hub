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
CLAUDE_HUB_DIR="${HOME}/claude-hub"
LOG_DIR="${CLAUDE_HUB_DIR}/logs"
CLAUDE_BIN="${HOME}/.local/bin/claude"
TMUX_BIN="${TMUX_PATH:-/opt/homebrew/bin/tmux}"
BACKOFF_SEC=5
# System-prompt file for `claude --append-system-prompt`. Overridable via env
# so tests / alt deploys can swap it. S3 (#49) populates the real content.
SYSTEM_PROMPT_FILE="${SYSTEM_PROMPT_FILE:-${CLAUDE_HUB_DIR}/scripts/hijoguchi-system-prompt.md}"
# Wait before checking the freshly-created tmux session. Short is fine because
# tmux new-session -d returns after the server has recorded the session.
TMUX_VERIFY_SLEEP_SEC=1

mkdir -p "${LOG_DIR}"

# Guard: abort if the system-prompt file is missing. Without this the claude
# invocation would silently pass `--append-system-prompt ""` and behaviour
# would drift from what S3 defines.
if [ ! -r "${SYSTEM_PROMPT_FILE}" ]; then
  echo "[hijoguchi] ERROR: system-prompt file not readable: ${SYSTEM_PROMPT_FILE}" >&2
  exit 1
fi

echo "[hijoguchi] system_prompt_file=${SYSTEM_PROMPT_FILE}"

# Clean shutdown on SIGTERM from launchd
trap 'echo "[hijoguchi] SIGTERM received, killing tmux session"; "${TMUX_BIN}" kill-session -t "${SESSION}" 2>/dev/null; exit 0' TERM INT

echo "[hijoguchi] watchdog starting at $(date)"

while true; do
  # Ensure no stale session
  "${TMUX_BIN}" kill-session -t "${SESSION}" 2>/dev/null

  echo "[hijoguchi] starting tmux session '${SESSION}' at $(date)"
  # Read the prompt in the parent shell and escape every argument with %q so
  # the string handed to tmux's child shell re-parses back to the exact same
  # argv — prompt content with $VAR, backticks, or quotes cannot leak into
  # command evaluation, and CLAUDE_BIN paths with spaces remain intact.
  SYSTEM_PROMPT_CONTENT="$(cat "${SYSTEM_PROMPT_FILE}")"
  CLAUDE_CMD=$(printf '%q ' \
    "${CLAUDE_BIN}" \
    --channels plugin:discord@claude-plugins-official \
    --dangerously-skip-permissions \
    --append-system-prompt "${SYSTEM_PROMPT_CONTENT}")
  "${TMUX_BIN}" new-session -d -s "${SESSION}" -c "${CLAUDE_HUB_DIR}" "${CLAUDE_CMD}"

  # Verify the session actually came up (AC-2). If not, log and back off.
  sleep "${TMUX_VERIFY_SLEEP_SEC}"
  if ! "${TMUX_BIN}" has-session -t "${SESSION}" 2>/dev/null; then
    echo "[hijoguchi] ERROR: tmux session '${SESSION}' failed to start" >&2
    sleep "${BACKOFF_SEC}"
    continue
  fi
  echo "[hijoguchi] tmux session verified: ${SESSION}"

  # Block while the session exists
  while "${TMUX_BIN}" has-session -t "${SESSION}" 2>/dev/null; do
    sleep 10
  done

  echo "[hijoguchi] session '${SESSION}' ended at $(date), backing off ${BACKOFF_SEC}s"
  sleep "${BACKOFF_SEC}"
done
