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
# Template placeholders injected into the system-prompt. Keeping IDs out of the
# prompt source (AC-4 / #49) means the prompt .md is agnostic of deployment;
# production IDs live here as defaults so launchd needs no extra env wiring.
# Override via env vars for tests / alt deploys. Full fail-closed (no default)
# requires plist env-var plumbing — tracked as follow-up hardening Issue.
HIJOGUCHI_CHANNEL_ID="${HIJOGUCHI_CHANNEL_ID:-1487701062205964329}"
HIJOGUCHI_BOT_MENTION="${HIJOGUCHI_BOT_MENTION:-<@1487717424173416538>}"
# Wait before checking the freshly-created tmux session. Short is fine because
# tmux new-session -d returns after the server has recorded the session.
TMUX_VERIFY_SLEEP_SEC=1

# Guard: abort if the system-prompt file is missing. Without this the claude
# invocation would silently pass `--append-system-prompt ""` and behaviour
# would drift from what S3 defines.
if [ ! -r "${SYSTEM_PROMPT_FILE}" ]; then
  echo "[hijoguchi] ERROR: system-prompt file not readable: ${SYSTEM_PROMPT_FILE}" >&2
  exit 1
fi

echo "[hijoguchi] system_prompt_file=${SYSTEM_PROMPT_FILE}" >&2

# Render the prompt once (AC-4 template expansion). Re-reading per restart is
# unnecessary — the launchd wrapper re-execs this script on crash anyway.
SYSTEM_PROMPT_CONTENT="$(cat "${SYSTEM_PROMPT_FILE}")"
# NOTE: `\{\{` escapes are REQUIRED — without them bash interprets the pattern
# as brace expansion and collapses it to a literal `}}`, silently producing a
# broken prompt. See PR #62 review discussion.
SYSTEM_PROMPT_CONTENT="${SYSTEM_PROMPT_CONTENT//\{\{HIJOGUCHI_CHANNEL_ID\}\}/${HIJOGUCHI_CHANNEL_ID}}"
SYSTEM_PROMPT_CONTENT="${SYSTEM_PROMPT_CONTENT//\{\{HIJOGUCHI_BOT_MENTION\}\}/${HIJOGUCHI_BOT_MENTION}}"

# Fail closed on unresolved tokens so a renamed placeholder can't silently ship
# the literal "{{FOO}}" into Claude's context. Matches `{{UPPER_SNAKE_OR_DIGIT}}`
# so tokens like `{{CHANNEL_ID_1}}` are also caught.
if [[ "${SYSTEM_PROMPT_CONTENT}" =~ \{\{[A-Z][A-Z0-9_]*\}\} ]]; then
  echo "[hijoguchi] ERROR: unresolved template token in rendered prompt: ${BASH_REMATCH[0]}" >&2
  exit 1
fi

# Dry-run: render and print the prompt, then exit. Used by tests (AC-4).
# Kept before any filesystem side effects so render-only stdout stays clean.
if [ "${HIJOGUCHI_RENDER_ONLY:-0}" = "1" ]; then
  printf '%s\n' "${SYSTEM_PROMPT_CONTENT}"
  exit 0
fi

# Create log dir only for real launches. Deferred past render-only so tests
# don't create directories as a side effect of `HIJOGUCHI_RENDER_ONLY=1`.
mkdir -p "${LOG_DIR}"

# Clean shutdown on SIGTERM from launchd
trap 'echo "[hijoguchi] SIGTERM received, killing tmux session" >&2; "${TMUX_BIN}" kill-session -t "${SESSION}" 2>/dev/null; exit 0' TERM INT

echo "[hijoguchi] watchdog starting at $(date)" >&2

while true; do
  # Ensure no stale session
  "${TMUX_BIN}" kill-session -t "${SESSION}" 2>/dev/null

  echo "[hijoguchi] starting tmux session '${SESSION}' at $(date)" >&2
  # Escape every argument with %q so the string handed to tmux's child shell
  # re-parses back to the exact same argv — prompt content with $VAR, backticks,
  # or quotes cannot leak into command evaluation, and CLAUDE_BIN paths with
  # spaces remain intact. SYSTEM_PROMPT_CONTENT is rendered once above.
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
  echo "[hijoguchi] tmux session verified: ${SESSION}" >&2

  # Block while the session exists
  while "${TMUX_BIN}" has-session -t "${SESSION}" 2>/dev/null; do
    sleep 10
  done

  echo "[hijoguchi] session '${SESSION}' ended at $(date), backing off ${BACKOFF_SEC}s" >&2
  sleep "${BACKOFF_SEC}"
done
