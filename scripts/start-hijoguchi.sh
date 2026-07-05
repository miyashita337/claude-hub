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

# --- Idle context reset (Issue #110) ---------------------------------------
# claudeHubExit accumulates every Discord message in one long-lived Claude Code
# session, so context grows unbounded and auto-compact fires at random times,
# stalling responses. A UserPromptSubmit hook
# (scripts/hijoguchi-record-activity.sh) stamps the epoch of each inbound
# message into LAST_MSG_TS_FILE; the watchdog below kills the session once it
# has been idle for HIJOGUCHI_IDLE_RESET_MIN minutes so the next message starts
# from a fresh context. Set the threshold to 0 to opt out entirely.
HIJOGUCHI_IDLE_RESET_MIN="${HIJOGUCHI_IDLE_RESET_MIN:-1440}"
# How often the watchdog re-checks idle / session liveness. Kept short (10s) so
# crash-restart latency is unchanged; the idle decision is threshold-based, not
# poll-count based, so a small poll only bounds reset latency, not its timing.
HIJOGUCHI_IDLE_POLL_SEC="${HIJOGUCHI_IDLE_POLL_SEC:-10}"
# Guard against a blank / non-numeric override: an invalid value would make the
# watchdog `sleep` fail and (without set -e) spin the loop into a 100% CPU busy
# loop. Fall back to 10s on anything that is not a positive integer.
if ! [[ "${HIJOGUCHI_IDLE_POLL_SEC}" =~ ^[1-9][0-9]*$ ]]; then
  echo "[hijoguchi] WARN: invalid HIJOGUCHI_IDLE_POLL_SEC='${HIJOGUCHI_IDLE_POLL_SEC}', using 10" >&2
  HIJOGUCHI_IDLE_POLL_SEC=10
fi
CLAUDE_HUB_STATE_DIR="${CLAUDE_HUB_STATE_DIR:-${HOME}/.claude-hub-state}"
LAST_MSG_TS_FILE="${LAST_MSG_TS_FILE:-${CLAUDE_HUB_STATE_DIR}/last-message-ts}"

# Decide whether the session has been idle long enough to reset. Prints
# "RESET" / "KEEP" and mirrors the decision in the exit status (0 = reset).
# `now` is overridable via HIJOGUCHI_NOW_EPOCH so tests stay deterministic.
# Every non-reset path fails safe (KEEP): opt-out, missing/corrupt stamp, or a
# not-yet-stale delta must never tear down an active session.
hijoguchi_idle_should_reset() {
  local reset_min now last delta
  reset_min="${HIJOGUCHI_IDLE_RESET_MIN}"
  if ! [[ "${reset_min}" =~ ^[0-9]+$ ]] || [ "${reset_min}" -eq 0 ]; then
    echo "KEEP"; return 1   # opt-out or non-numeric → never reset
  fi
  if [ ! -r "${LAST_MSG_TS_FILE}" ]; then
    echo "KEEP"; return 1   # no activity recorded yet → treat as fresh
  fi
  last="$(cat "${LAST_MSG_TS_FILE}" 2>/dev/null)"
  if ! [[ "${last}" =~ ^[0-9]+$ ]]; then
    echo "KEEP"; return 1   # corrupt stamp → fail safe, keep the session
  fi
  now="${HIJOGUCHI_NOW_EPOCH:-$(date +%s)}"
  delta=$(( now - last ))
  if [ "${delta}" -ge $(( reset_min * 60 )) ]; then
    echo "RESET"; return 0
  fi
  echo "KEEP"; return 1
}

# Stamp the activity file with the current time. Used to baseline a freshly
# launched session so it is not reset before the first Discord message arrives.
hijoguchi_write_activity_baseline() {
  mkdir -p "${CLAUDE_HUB_STATE_DIR}" 2>/dev/null
  if ! date +%s > "${LAST_MSG_TS_FILE}" 2>/dev/null; then
    echo "[hijoguchi] WARN: cannot write activity baseline to ${LAST_MSG_TS_FILE}" >&2
  fi
}

# Dry-run: print the idle decision and exit. Used by tests to exercise the
# threshold logic without spawning tmux/claude. Placed before the required-env
# checks so the decision logic can be tested without channel/bot IDs.
if [ "${HIJOGUCHI_IDLE_DECISION_ONLY:-0}" = "1" ]; then
  hijoguchi_idle_should_reset
  exit $?
fi
# ---------------------------------------------------------------------------

# --- Health: hang / dead detection + notify (Issue #313, Epic #315) ---------
# Folds hang/dead judgement into the existing 10s poll loop (no new resident
# process). Reads the state files written by the #312 producer
# (scripts/hijoguchi-record-turn-state.sh):
#   bot-status.json  {state:"processing"|"idle", since, ...}
#   heartbeat        mtime = last in-turn tool progress
#
# The producer's state flag is NEVER trusted alone (RW-023 push-and-trust): a
# crash mid-turn leaves state=processing forever, so "hang" additionally
# requires a stale progress clock AND no busy child process under the pane
# (an in-flight long tool call is progress even before PostToolUse fires).
#
# WARN-first (thin-scaffolding): notify only — no automatic kill/reset here.
# Escalation to auto-recovery is a separate decision after a false-positive-
# free dogfood period.
#
# Notifications are EDGE-TRIGGERED via a sentinel file: one incident = one
# push (hang or dead), one recovery = one push, nothing for idle/processing
# (RW-058 "failure-transition-only" shape).
HIJOGUCHI_HANG_SEC="${HIJOGUCHI_HANG_SEC:-540}"
# Crash-loop: N session deaths within WINDOW seconds → "dead". launchd
# KeepAlive absorbs a single crash silently (self-healing, not actionable);
# only the loop is worth a push.
HIJOGUCHI_CRASHLOOP_N="${HIJOGUCHI_CRASHLOOP_N:-3}"
HIJOGUCHI_CRASHLOOP_WINDOW_SEC="${HIJOGUCHI_CRASHLOOP_WINDOW_SEC:-180}"
BOT_STATUS_FILE="${CLAUDE_HUB_STATE_DIR}/bot-status.json"
HEARTBEAT_FILE="${CLAUDE_HUB_STATE_DIR}/heartbeat"
HEALTH_SENTINEL_FILE="${CLAUDE_HUB_STATE_DIR}/health-incident"
RESTART_LOG_FILE="${CLAUDE_HUB_STATE_DIR}/restart-log"
HIJOGUCHI_PUSHOVER_CMD="${HIJOGUCHI_PUSHOVER_CMD:-${HOME}/.claude/scripts/pushover-notify.sh}"
HIJOGUCHI_NOTIFIER_CMD="${HIJOGUCHI_NOTIFIER_CMD:-/opt/homebrew/bin/terminal-notifier}"

# GNU stat uses -c %Y for mtime; BSD/macOS uses -f %m. GNU must be tried
# first: on GNU, `stat -f %m` SUCCEEDS but prints filesystem info, not mtime.
hijoguchi_mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# Best-effort dual notify (Pushover for iPhone, terminal-notifier for at-desk).
# Both mockable via env for tests; a missing binary must never wedge the loop.
hijoguchi_notify() { # $1 = title, $2 = message
  if [ -r "${HIJOGUCHI_PUSHOVER_CMD}" ] || command -v "${HIJOGUCHI_PUSHOVER_CMD}" >/dev/null 2>&1; then
    bash "${HIJOGUCHI_PUSHOVER_CMD}" "$1" "$2" >/dev/null 2>&1 || true
  fi
  if command -v "${HIJOGUCHI_NOTIFIER_CMD}" >/dev/null 2>&1; then
    "${HIJOGUCHI_NOTIFIER_CMD}" -title "$1" -message "$2" >/dev/null 2>&1 || true
  fi
}

# Busy-child probe (lightweight bash take on the #279/#307 busy primitive —
# NO code coupling to auto-reap; hijoguchi is outside sessions.db). Any
# descendant of the tmux pane beyond the claude process itself means a tool
# subprocess is running = real work in flight. Overridable for tests. Any
# probe failure reports busy (1): suppressing a hang push is the fail-safe
# direction under WARN-first.
hijoguchi_busy_children() {
  if [ -n "${HIJOGUCHI_BUSY_OVERRIDE:-}" ]; then
    printf '%s\n' "${HIJOGUCHI_BUSY_OVERRIDE}"
    return 0
  fi
  local pane_pid kids k
  pane_pid="$("${TMUX_BIN}" list-panes -t "${SESSION}" -F '#{pane_pid}' 2>/dev/null | head -1)"
  if ! [[ "${pane_pid}" =~ ^[0-9]+$ ]]; then
    echo 1; return 0   # cannot probe → assume busy (fail safe, no false push)
  fi
  kids="$(pgrep -P "${pane_pid}" 2>/dev/null)"
  for k in ${kids}; do
    if pgrep -P "${k}" >/dev/null 2>&1; then
      echo 1; return 0
    fi
  done
  echo 0
}

# Classify current health: prints "hang" or "ok". "dead" is judged separately
# from the restart log (a dead session can't be probed from inside the poll
# loop — the loop only runs while tmux has-session is true).
hijoguchi_health_state() {
  local hang_sec="${HIJOGUCHI_HANG_SEC}" state since hb last_progress now
  if ! [[ "${hang_sec}" =~ ^[1-9][0-9]*$ ]]; then
    echo ok; return 0   # opt-out / bad threshold → never flag
  fi
  [ -r "${BOT_STATUS_FILE}" ] || { echo ok; return 0; }
  state="$(jq -r '.state // empty' "${BOT_STATUS_FILE}" 2>/dev/null)"
  [ "${state}" = "processing" ] || { echo ok; return 0; }
  since="$(jq -r '.since // empty' "${BOT_STATUS_FILE}" 2>/dev/null)"
  [[ "${since}" =~ ^[0-9]+$ ]] || { echo ok; return 0; }
  # Last progress = the NEWER of turn start and heartbeat mtime. A stale
  # heartbeat left over from the previous turn must not flag a turn that has
  # only just started (false hang at turn boundary).
  last_progress="${since}"
  hb="$(hijoguchi_mtime_of "${HEARTBEAT_FILE}")"
  if [[ "${hb}" =~ ^[0-9]+$ ]] && [ "${hb}" -gt "${last_progress}" ]; then
    last_progress="${hb}"
  fi
  now="${HIJOGUCHI_NOW_EPOCH:-$(date +%s)}"
  if [ $(( now - last_progress )) -le "${hang_sec}" ]; then
    echo ok; return 0
  fi
  if [ "$(hijoguchi_busy_children)" = "1" ]; then
    echo ok; return 0   # long single tool call still running = progress
  fi
  echo hang
}

# One edge-triggered health tick. Called every poll while the session is
# alive. Sentinel transitions:
#   no sentinel + hang       → write sentinel(hang), notify HANG (once)
#   sentinel(hang) + ok      → clear, notify RECOVERED
#   sentinel(dead) + stable  → clear, notify RECOVERED (stable = last crash
#                              older than the crash-loop window; clearing on
#                              the first tick would re-arm and re-push on
#                              every bounce of an ongoing crash loop)
hijoguchi_health_tick() {
  local st sentinel="" now last_crash
  st="$(hijoguchi_health_state)"
  [ -r "${HEALTH_SENTINEL_FILE}" ] && sentinel="$(cat "${HEALTH_SENTINEL_FILE}" 2>/dev/null)"
  if [ "${st}" = "hang" ]; then
    if [ -z "${sentinel}" ]; then
      mkdir -p "${CLAUDE_HUB_STATE_DIR}" 2>/dev/null
      printf 'hang\n' > "${HEALTH_SENTINEL_FILE}" 2>/dev/null || true
      hijoguchi_notify "claudeHubExit HANG" \
        "processing but no progress for >${HIJOGUCHI_HANG_SEC}s (heartbeat stale, no busy child). WARN-first: not auto-killed."
    fi
    return 0
  fi
  case "${sentinel}" in
    hang)
      rm -f "${HEALTH_SENTINEL_FILE}" 2>/dev/null
      hijoguchi_notify "claudeHubExit RECOVERED" "recovered from hang (turn progressed or completed)."
      ;;
    dead)
      now="${HIJOGUCHI_NOW_EPOCH:-$(date +%s)}"
      last_crash="$(tail -1 "${RESTART_LOG_FILE}" 2>/dev/null)"
      if ! [[ "${last_crash}" =~ ^[0-9]+$ ]] \
         || [ $(( now - last_crash )) -gt "${HIJOGUCHI_CRASHLOOP_WINDOW_SEC}" ]; then
        rm -f "${HEALTH_SENTINEL_FILE}" 2>/dev/null
        hijoguchi_notify "claudeHubExit RECOVERED" "recovered from crash loop (session stable again)."
      fi
      ;;
  esac
  return 0
}

# Record one unexpected session death and judge crash-loop. Prints "DEAD" and
# notifies (edge-triggered) when HIJOGUCHI_CRASHLOOP_N deaths landed within
# HIJOGUCHI_CRASHLOOP_WINDOW_SEC; prints "OK" otherwise. Intentional idle
# resets must NOT call this — they are scheduled, not crashes.
hijoguchi_note_crash() {
  local now pruned count sentinel=""
  now="${HIJOGUCHI_NOW_EPOCH:-$(date +%s)}"
  mkdir -p "${CLAUDE_HUB_STATE_DIR}" 2>/dev/null
  printf '%s\n' "${now}" >> "${RESTART_LOG_FILE}" 2>/dev/null || true
  # Prune entries older than the window (keeps the log tiny and the count O(N)).
  pruned="$(awk -v cutoff=$(( now - HIJOGUCHI_CRASHLOOP_WINDOW_SEC )) \
    '$1 ~ /^[0-9]+$/ && $1 >= cutoff' "${RESTART_LOG_FILE}" 2>/dev/null)"
  printf '%s\n' "${pruned}" > "${RESTART_LOG_FILE}" 2>/dev/null || true
  count="$(grep -c '[0-9]' "${RESTART_LOG_FILE}" 2>/dev/null || echo 0)"
  if [ "${count}" -ge "${HIJOGUCHI_CRASHLOOP_N}" ]; then
    [ -r "${HEALTH_SENTINEL_FILE}" ] && sentinel="$(cat "${HEALTH_SENTINEL_FILE}" 2>/dev/null)"
    if [ "${sentinel}" != "dead" ]; then
      printf 'dead\n' > "${HEALTH_SENTINEL_FILE}" 2>/dev/null || true
      hijoguchi_notify "claudeHubExit DEAD" \
        "crash loop: ${count} session deaths within ${HIJOGUCHI_CRASHLOOP_WINDOW_SEC}s (launchd keeps restarting)."
    fi
    echo "DEAD"; return 0
  fi
  echo "OK"; return 0
}

# Dry-run hooks for tests (same pattern as HIJOGUCHI_IDLE_DECISION_ONLY;
# placed before the required-env checks so health logic is testable without
# channel/bot IDs).
if [ "${HIJOGUCHI_HEALTH_TICK_ONLY:-0}" = "1" ]; then
  hijoguchi_health_tick
  exit 0
fi
if [ "${HIJOGUCHI_CRASH_NOTE_ONLY:-0}" = "1" ]; then
  hijoguchi_note_crash
  exit 0
fi
# ---------------------------------------------------------------------------

# System-prompt file for `claude --append-system-prompt`. Overridable via env
# so tests / alt deploys can swap it. S3 (#49) populates the real content.
SYSTEM_PROMPT_FILE="${SYSTEM_PROMPT_FILE:-${CLAUDE_HUB_DIR}/scripts/hijoguchi-system-prompt.md}"
# Template placeholders injected into the system-prompt. Keeping IDs out of the
# prompt source (AC-4 / #49) means the prompt .md is agnostic of deployment;
# every deployment must inject its own IDs via launchd plist
# `EnvironmentVariables` (see docs/bot-operations.md). Issue #63 removed the
# previous production-ID defaults so a missing/typo'd plist entry can no
# longer silently route to the legacy production channel — fail-closed.
HIJOGUCHI_CHANNEL_ID="${HIJOGUCHI_CHANNEL_ID:-}"
HIJOGUCHI_BOT_MENTION="${HIJOGUCHI_BOT_MENTION:-}"

if [ -z "${HIJOGUCHI_CHANNEL_ID}" ]; then
  echo "[hijoguchi] ERROR: HIJOGUCHI_CHANNEL_ID is required. Inject via launchd plist EnvironmentVariables; see docs/bot-operations.md (Issue #63 fail-closed)." >&2
  exit 1
fi
if [ -z "${HIJOGUCHI_BOT_MENTION}" ]; then
  echo "[hijoguchi] ERROR: HIJOGUCHI_BOT_MENTION is required. Inject via launchd plist EnvironmentVariables; see docs/bot-operations.md (Issue #63 fail-closed)." >&2
  exit 1
fi
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
# NOTE: `-` (not `:-`) so an empty string stays empty and lands in enforce,
# rather than being silently upgraded to "1". Only an unset variable gets
# the legacy default.
CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS="${CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS-1}"

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
# Inject the activity-tracking context with an explicit `env` prefix rather than
# relying on `export` + tmux inheritance. When a tmux server is ALREADY running
# (this script uses the default socket, which commonly pre-exists), `tmux
# new-session` spawns the pane from the *server's* cached environment, so a
# freshly-exported var does not reach the claude process or its UserPromptSubmit
# hook — the hook would then always skip and the idle timer would never warm,
# resetting the session on a fixed schedule regardless of activity. `env` sets
# the vars on the claude process directly, independent of server state.
# HIJOGUCHI_CHANNEL_ID / HIJOGUCHI_BOT_MENTION are forwarded explicitly (not via
# export) for the same reason as the activity-tracking vars above: when the tmux
# server pre-exists, the claude pane inherits the server's cached env, so the
# in-session mechanical mention gate (#267: hijoguchi-discord-gate.sh /
# hijoguchi-record-channel-context.sh) would not see them and would fail open /
# misclassify. The `env` prefix sets them on the claude process directly.
CLAUDE_CMD=$(printf 'env CLAUDE_HUB_HIJOGUCHI_SESSION=1 CLAUDE_HUB_STATE_DIR=%q LAST_MSG_TS_FILE=%q HIJOGUCHI_CHANNEL_ID=%q HIJOGUCHI_BOT_MENTION=%q ' \
  "${CLAUDE_HUB_STATE_DIR}" "${LAST_MSG_TS_FILE}" "${HIJOGUCHI_CHANNEL_ID}" "${HIJOGUCHI_BOT_MENTION}")
# The rendered prompt must NOT be inlined (%q-escaped) into the tmux command
# string: multibyte content escapes to ~3x its size and tmux rejects commands
# over its ~16KB limit with "command too long" — the #311 prompt growth pushed
# the inline form past that and crash-looped the Bot (Epic #315 hotfix). The
# prompt is persisted to RENDERED_PROMPT_FILE below and the PANE SHELL expands
# `"$(cat <file>)"` at launch, so the command string stays O(100B) no matter
# how large the prompt grows. Command-substitution output is not re-parsed by
# the shell, so prompt content still cannot leak into command evaluation; the
# file path itself is %q-escaped.
RENDERED_PROMPT_FILE="${RENDERED_PROMPT_FILE:-${CLAUDE_HUB_STATE_DIR}/rendered-system-prompt.md}"
_prompt_value_next=0
for _arg in "${CLAUDE_ARGV[@]}"; do
  if [ "${_prompt_value_next}" = "1" ]; then
    CLAUDE_CMD+="\"\$(cat $(printf '%q' "${RENDERED_PROMPT_FILE}"))\" "
    _prompt_value_next=0
    continue
  fi
  [ "${_arg}" = "--append-system-prompt" ] && _prompt_value_next=1
  CLAUDE_CMD+="$(printf '%q ' "${_arg}")"
done

# Opt-in introspection for tests: print the fully-built launch command (incl.
# the env prefix) and exit before any tmux / filesystem side effect.
if [ "${HIJOGUCHI_PRINT_CMD:-0}" = "1" ]; then
  printf '%s\n' "${CLAUDE_CMD}"
  exit 0
fi

# Create log dir only for real launches. Deferred past render-only / print-argv
# so tests don't create directories as a side effect.
mkdir -p "${LOG_DIR}"

# Persist the rendered prompt for the pane shell's `"$(cat ...)"` expansion.
# Fail loud (like the SYSTEM_PROMPT_FILE guard): a missing prompt file would
# otherwise launch claude with an empty --append-system-prompt and silently
# drop every routing/scope rule. Deferred past the dry-run exits above so
# tests stay side-effect free. 0600 + state dir keeps the embedded channel /
# bot IDs out of world-readable locations AND out of `ps` argv (the previous
# inline form exposed them to any local process listing).
mkdir -p "${CLAUDE_HUB_STATE_DIR}"
if ! printf '%s' "${SYSTEM_PROMPT_CONTENT}" > "${RENDERED_PROMPT_FILE}"; then
  echo "[hijoguchi] ERROR: cannot write rendered prompt to ${RENDERED_PROMPT_FILE}" >&2
  exit 1
fi
chmod 600 "${RENDERED_PROMPT_FILE}" 2>/dev/null || true

# Clean shutdown on SIGTERM from launchd
trap 'echo "[hijoguchi] SIGTERM received, killing tmux session" >&2; "${TMUX_BIN}" kill-session -t "${SESSION}" 2>/dev/null; exit 0' TERM INT

echo "[hijoguchi] watchdog starting at $(date)" >&2

# The activity-tracking context is propagated to the in-session
# UserPromptSubmit hook (scripts/hijoguchi-record-activity.sh) via the explicit
# `env` prefix baked into CLAUDE_CMD above — NOT via these exports, because tmux
# does not reliably inherit a freshly-exported var when the server pre-exists
# (see the CLAUDE_CMD comment). The exports remain as harmless defense-in-depth
# for the fresh-server case; the marker scopes the hook to THIS session so a
# developer running `claude` in ~/claude-hub never warms the idle timer.
export CLAUDE_HUB_HIJOGUCHI_SESSION=1
export CLAUDE_HUB_STATE_DIR
export LAST_MSG_TS_FILE

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

  # Baseline the activity timestamp so a fresh session isn't reset before the
  # first Discord message stamps it (Issue #110).
  hijoguchi_write_activity_baseline

  # Block while the session exists. Every HIJOGUCHI_IDLE_POLL_SEC, re-check
  # whether the session has been idle past the reset threshold; if so, kill it
  # so the outer loop restarts claude with a fresh context. The same tick also
  # runs the hang/dead health judgement (#313) — no extra polling loop.
  INTENTIONAL_RESTART=0
  while "${TMUX_BIN}" has-session -t "${SESSION}" 2>/dev/null; do
    if [ "$(hijoguchi_idle_should_reset)" = "RESET" ]; then
      echo "[hijoguchi] idle >= ${HIJOGUCHI_IDLE_RESET_MIN}min, resetting session for fresh context at $(date)" >&2
      INTENTIONAL_RESTART=1
      "${TMUX_BIN}" kill-session -t "${SESSION}" 2>/dev/null
      break
    fi
    hijoguchi_health_tick
    sleep "${HIJOGUCHI_IDLE_POLL_SEC}"
  done

  # An unexpected death (not the scheduled idle reset) counts toward the
  # crash-loop judgement; a scheduled reset is not a crash.
  if [ "${INTENTIONAL_RESTART}" = "0" ]; then
    if [ "$(hijoguchi_note_crash)" = "DEAD" ]; then
      echo "[hijoguchi] crash loop detected (>=${HIJOGUCHI_CRASHLOOP_N} deaths in ${HIJOGUCHI_CRASHLOOP_WINDOW_SEC}s) at $(date)" >&2
    fi
  fi

  echo "[hijoguchi] session '${SESSION}' ended at $(date), backing off ${BACKOFF_SEC}s" >&2
  sleep "${BACKOFF_SEC}"
done
