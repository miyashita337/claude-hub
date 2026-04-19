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

# Phase 1 migration (Issue #53): gate --dangerously-skip-permissions behind an
# env var so we can flip to strict permissions mode in Phase 2 without another
# code change. Default "1" preserves current behaviour during rollout;
# operators can set to "0" in the launchd plist to exercise the allow/deny
# rules in .claude/settings.json (auto-loaded from CWD). Any value other than
# exactly "1" is treated as "enforce" — fail-closed so typos don't silently
# reinstate bypass.
CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS="${CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS:-1}"

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

# Build the claude argv once — SYSTEM_PROMPT_CONTENT is invariant across
# restarts and the permission-mode branch is based on an env var, so the
# argv doesn't need to be recomputed on every loop iteration. Hoisting it
# up also lets HIJOGUCHI_PRINT_ARGV exit before any mkdir / tmux side effect.
#
# In unsafe-skip mode (env=1, current default) we pass --dangerously-skip-
# permissions for backward compat. In enforce mode (env=0) we drop it and
# let claude fall back to the allow/deny rules in .claude/settings.json —
# that file is auto-loaded because tmux new-session runs with
# -c "${CLAUDE_HUB_DIR}". Either way, log the chosen mode to stderr so
# launchd captures the active policy in hijoguchi.stderr.log (AC-4).
CLAUDE_ARGV=(
  "${CLAUDE_BIN}"
  --channels plugin:discord@claude-plugins-official
)
if [ "${CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS}" = "1" ]; then
  echo "[hijoguchi] permission_mode=unsafe_skip (legacy; set CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=0 to enforce)" >&2
  CLAUDE_ARGV+=(--dangerously-skip-permissions)
else
  echo "[hijoguchi] permission_mode=enforce (using .claude/settings.json allow/deny rules)" >&2
fi
CLAUDE_ARGV+=(--append-system-prompt "${SYSTEM_PROMPT_CONTENT}")

# Dry-run: print the argv (one arg per line) and exit. Used by tests to
# verify the permission-mode conditional (AC-1) without starting tmux or
# creating the log directory. The --append-system-prompt value is redacted
# because the rendered prompt embeds channel / bot IDs — safe to store in
# source but not safe to paste into bug reports or CI logs.
if [ "${HIJOGUCHI_PRINT_ARGV:-0}" = "1" ]; then
  _redact_next=0
  for _arg in "${CLAUDE_ARGV[@]}"; do
    if [ "${_redact_next}" = "1" ]; then
      printf '[REDACTED]\n'
      _redact_next=0
    elif [ "${_arg}" = "--append-system-prompt" ]; then
      printf '%s\n' "${_arg}"
      _redact_next=1
    else
      printf '%s\n' "${_arg}"
    fi
  done
  exit 0
fi

# Escape every argument with %q so the string handed to tmux's child shell
# re-parses back to the exact same argv — prompt content with $VAR, backticks,
# or quotes cannot leak into command evaluation, and CLAUDE_BIN paths with
# spaces remain intact.
CLAUDE_CMD=$(printf '%q ' "${CLAUDE_ARGV[@]}")

# Create log dir only for real launches. Deferred past render-only / print-argv
# so tests don't create directories as a side effect.
mkdir -p "${LOG_DIR}"

# Clean shutdown on SIGTERM from launchd
trap 'echo "[hijoguchi] SIGTERM received, killing tmux session" >&2; "${TMUX_BIN}" kill-session -t "${SESSION}" 2>/dev/null; exit 0' TERM INT

echo "[hijoguchi] watchdog starting at $(date)" >&2

while true; do
  # Ensure no stale session
  "${TMUX_BIN}" kill-session -t "${SESSION}" 2>/dev/null

  echo "[hijoguchi] starting tmux session '${SESSION}' at $(date)" >&2
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
