#!/bin/bash
# Unit tests for scripts/start-hijoguchi.sh prompt rendering (#49 AC-4).
# Run standalone: bash scripts/test-start-hijoguchi.sh
# Exits 0 on all-pass, 1 on any failure.
#
# Test case functions (tN_*) are invoked indirectly through `run "..." fn_name`.
# shellcheck disable=SC2329

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${SCRIPT_DIR}/start-hijoguchi.sh"
PROMPT_FILE="${SCRIPT_DIR}/hijoguchi-system-prompt.md"

# Pin the prompt file to the in-tree fixture so tests don't pick up a stale
# copy from `~/claude-hub/scripts/` when run from a worktree or alternate
# checkout. Individual tests can still override by re-exporting.
export SYSTEM_PROMPT_FILE="${PROMPT_FILE}"

# Default test env: Issue #63 made HIJOGUCHI_CHANNEL_ID and
# HIJOGUCHI_BOT_MENTION required (fail-closed). Tests that don't specifically
# exercise the unset path inherit these so the script reaches its render path.
# Use sentinel values that don't collide with the historical production ID so
# accidental leaks into source/docs are easier to spot.
export HIJOGUCHI_CHANNEL_ID="${HIJOGUCHI_CHANNEL_ID:-TEST_CHANNEL_DEFAULT_999}"
export HIJOGUCHI_BOT_MENTION="${HIJOGUCHI_BOT_MENTION:-<@TEST_BOT_DEFAULT_888>}"

fail=0
run() {
  local name="$1"; shift
  if "$@"; then echo "PASS ${name}"; else echo "FAIL ${name}"; fail=1; fi
}

t1_channel_id_expanded() {
  # After #63 the script no longer carries a production-ID default; the test
  # asserts the env-injected sentinel reaches the rendered prompt instead.
  HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1 | grep -Fq "${HIJOGUCHI_CHANNEL_ID}"
}

t2_no_residual_tokens() {
  ! HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1 | grep -Eq '\{\{[A-Z][A-Z0-9_]*\}\}'
}

t3_env_override() {
  HIJOGUCHI_RENDER_ONLY=1 HIJOGUCHI_CHANNEL_ID=TEST_CHAN_99 \
    bash "${TARGET}" 2>&1 | grep -Fq 'TEST_CHAN_99'
}

t4_unresolved_token_fails() {
  local tmpfile
  tmpfile=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '${tmpfile}'" RETURN
  echo "chan={{UNKNOWN_TOKEN}}" > "${tmpfile}"
  ! HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE="${tmpfile}" \
      bash "${TARGET}" >/dev/null 2>&1
}

t5_missing_prompt_fails() {
  ! HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE=/nonexistent/path \
      bash "${TARGET}" >/dev/null 2>&1
}

t6_source_no_hardcoded_id() {
  # Two-fold guarantee after #63: prompt fixture stays placeholder-only AND
  # start-hijoguchi.sh no longer carries the production channel ID as default.
  ! grep -Fq '1487701062205964329' "${PROMPT_FILE}" && \
    ! grep -Fq '1487701062205964329' "${TARGET}"
}

t7_source_has_placeholder() {
  grep -Fq '{{HIJOGUCHI_CHANNEL_ID}}' "${PROMPT_FILE}"
}

# AC-1 smoke: rendered prompt still defines the primary-channel condition
# after template expansion. Cross-checks both the condition heading and the
# expanded chat_id so silent deletion of Condition 1 can't pass just because
# the format-description line still mentions 'chat_id'.
t8_rendered_has_primary_rule() {
  local channel_id="TEST_PRIMARY_123"
  local out
  out=$(HIJOGUCHI_RENDER_ONLY=1 HIJOGUCHI_CHANNEL_ID="${channel_id}" \
    bash "${TARGET}" 2>&1)
  echo "${out}" | grep -Fq '### 条件1: Primary チャンネル内' && \
    echo "${out}" | grep -Fq "メッセージの \`chat_id\` が \`${channel_id}\`"
}

# AC-3 smoke: rendered prompt still includes the maintenance-keyword list.
# Guards against someone stripping keywords (which would break off-primary
# routing for legitimate claude-hub maintenance discussion).
t9_rendered_has_keywords() {
  local out
  out=$(HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1)
  echo "${out}" | grep -Fq 'supervisor' && \
    echo "${out}" | grep -Fq 'hijoguchi'
}

# AC-2 smoke: Bot mention placeholder expands via HIJOGUCHI_BOT_MENTION env
# var. Ensures the self-mention rule can be unambiguously tied to a specific
# Bot ID per deployment.
t10_bot_mention_expanded() {
  local mention="<@99999999>"
  HIJOGUCHI_RENDER_ONLY=1 HIJOGUCHI_BOT_MENTION="${mention}" \
    bash "${TARGET}" 2>&1 | grep -Fq "${mention}"
}

# --- S7 (#53) --dangerously-skip-permissions conditional tests ---

# AC-1: default (env unset) keeps legacy behaviour → flag is present.
# Regression guard: if someone flips the default to enforce, the Bot's
# current production workload would break silently without a plist change.
t11_default_includes_skip_flag() {
  HIJOGUCHI_PRINT_ARGV=1 bash "${TARGET}" 2>/dev/null \
    | grep -Fxq -- '--dangerously-skip-permissions'
}

# AC-1: explicit unsafe=1 includes the flag (escape hatch still works after
# the default is flipped in Phase 2).
t12_unsafe_env_includes_skip_flag() {
  HIJOGUCHI_PRINT_ARGV=1 CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=1 \
    bash "${TARGET}" 2>/dev/null \
    | grep -Fxq -- '--dangerously-skip-permissions'
}

# AC-1: enforce mode (env=0) omits the flag. This is the Phase 2 target
# state; the test ensures the branch is actually reachable from a plist
# env var and that no other codepath silently re-adds the flag.
t13_enforce_env_omits_skip_flag() {
  ! HIJOGUCHI_PRINT_ARGV=1 CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=0 \
      bash "${TARGET}" 2>/dev/null \
    | grep -Fxq -- '--dangerously-skip-permissions'
}

# AC-1 fail-closed: any non-"1" value (typos, empty, "true", etc.) falls
# into enforce mode so a malformed plist can't accidentally reinstate bypass.
# Empty-string is the most regression-prone case (Bash `:-` vs `-` expansion)
# so it gets its own explicit assertion.
t14_unknown_env_omits_skip_flag() {
  ! HIJOGUCHI_PRINT_ARGV=1 CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=true \
      bash "${TARGET}" 2>/dev/null \
    | grep -Fxq -- '--dangerously-skip-permissions' \
    && \
  ! HIJOGUCHI_PRINT_ARGV=1 CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS= \
      bash "${TARGET}" 2>/dev/null \
    | grep -Fxq -- '--dangerously-skip-permissions'
}

# AC-4: active permission mode is logged to stderr (enforce variant). The
# launchd plist pipes stderr to logs/hijoguchi.stderr.log so this makes the
# policy auditable from the log file.
t15_enforce_mode_logged() {
  HIJOGUCHI_PRINT_ARGV=1 CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=0 \
    bash "${TARGET}" 2>&1 >/dev/null \
    | grep -Fq '[hijoguchi] permission_mode=enforce'
}

t16_unsafe_mode_logged() {
  HIJOGUCHI_PRINT_ARGV=1 CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=1 \
    bash "${TARGET}" 2>&1 >/dev/null \
    | grep -Fq '[hijoguchi] permission_mode=unsafe_skip'
}

# AC-2: .claude/settings.json exists at the project root with the required
# permission sections. The hijoguchi Bot auto-loads this file because its
# CWD is CLAUDE_HUB_DIR.
t17_settings_has_allow_and_deny() {
  local settings="${SCRIPT_DIR}/../.claude/settings.json"
  [ -f "${settings}" ] || return 1
  # Minimal structural check; full schema validation would need bun/jq.
  grep -Fq '"allow"' "${settings}" && \
    grep -Fq '"deny"' "${settings}" && \
    grep -Fq 'Bash(sudo' "${settings}"
}

# AC-1 regression: the legacy flag must appear in exactly one non-comment
# line in the source (inside the conditional). More than one match on a
# non-comment line means an unconditional path leaked back in.
t18_single_flag_occurrence() {
  local n
  n=$(grep -v '^[[:space:]]*#' "${TARGET}" | grep -c -- '--dangerously-skip-permissions')
  [ "${n}" -eq 1 ]
}

# Security: HIJOGUCHI_PRINT_ARGV must redact the system-prompt value so
# dry-run output is safe to paste into bug reports / CI logs. The prompt
# embeds channel and bot IDs that an attacker could use to fine-tune
# mention-forgery injection.
t19_print_argv_redacts_prompt() {
  local out
  out=$(HIJOGUCHI_PRINT_ARGV=1 bash "${TARGET}" 2>/dev/null)
  # The sentinel string appears in the rendered prompt; it must NOT leak.
  # Use the expanded channel ID as a cheap proxy since the full prompt text
  # may drift over time.
  echo "${out}" | grep -Fq '[REDACTED]' && \
    ! echo "${out}" | grep -Fq '1487701062205964329'
}

# settings.json deny covers known dangerous vectors. Phase 1.5 (PR #126)
# moved read-only viewers and runtime invocations (cat / bun / sh / etc)
# from deny to allow because they were a /pdca workflow bottleneck. The
# remaining deny set must still cover privilege escalation, irreversible
# destruction, network exfil, shell injection, and destructive git ops.
# Listed here so a future edit that drops any of them surfaces in the
# test rather than only in a manual security review.
t20_settings_deny_covers_bypass_vectors() {
  local settings="${SCRIPT_DIR}/../.claude/settings.json"
  # privilege escalation
  grep -Fq '"Bash(sudo:*)"' "${settings}" && \
    # irreversible destruction (recursive rm with all uppercase / lowercase variants)
    grep -Fq '"Bash(rm -rf:*)"' "${settings}" && \
    grep -Fq '"Bash(rm -Rf:*)"' "${settings}" && \
    grep -Fq '"Bash(rm -fR:*)"' "${settings}" && \
    grep -Fq '"Bash(rm -R:*)"' "${settings}" && \
    grep -Fq '"Bash(dd:*)"' "${settings}" && \
    grep -Fq '"Bash(mkfs:*)"' "${settings}" && \
    # network exfil
    grep -Fq '"Bash(curl:*)"' "${settings}" && \
    grep -Fq '"Bash(wget:*)"' "${settings}" && \
    grep -Fq '"Bash(ssh:*)"' "${settings}" && \
    grep -Fq '"Bash(scp:*)"' "${settings}" && \
    # shell injection
    grep -Fq '"Bash(eval:*)"' "${settings}" && \
    grep -Fq '"Bash(exec:*)"' "${settings}" && \
    # destructive git
    grep -Fq '"Bash(git diff --no-index:*)"' "${settings}" && \
    grep -Fq '"Bash(git push --force:*)"' "${settings}" && \
    grep -Fq '"Bash(git push -f:*)"' "${settings}" && \
    # gh CLI surface kept narrow (auth/secret/config remain denied)
    grep -Fq '"Bash(gh auth token:*)"' "${settings}" && \
    grep -Fq '"Bash(gh secret:*)"' "${settings}" && \
    # Bash viewer secret-path denies (CodeRabbit CR3 Phase 1.5)
    grep -Fq '"Bash(cat .env)"' "${settings}" && \
    grep -Fq '"Bash(cat /Users/*/.aws:*)"' "${settings}" && \
    grep -Fq '"Bash(cat /Users/*/.ssh:*)"' "${settings}" && \
    grep -Fq '"Bash(cat *credentials*)"' "${settings}" && \
    grep -Fq '"Bash(cat *id_rsa*)"' "${settings}" && \
    grep -Fq '"Bash(head .env)"' "${settings}" && \
    grep -Fq '"Bash(tail .env)"' "${settings}"
}

# Issue #63 fail-closed: the script must abort with a non-zero exit code when
# either env var is unset, even when the prompt file and other state are fine.
# Without this, a typo'd or missing plist EnvironmentVariables silently routes
# to whatever default lived in source — exactly the silent-degrade hazard #63
# closes.
t21_unset_channel_id_fails() {
  ! env -u HIJOGUCHI_CHANNEL_ID HIJOGUCHI_BOT_MENTION='<@TEST>' \
      HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE="${PROMPT_FILE}" \
      bash "${TARGET}" >/dev/null 2>&1
}

t22_unset_channel_id_logs_error() {
  env -u HIJOGUCHI_CHANNEL_ID HIJOGUCHI_BOT_MENTION='<@TEST>' \
    HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE="${PROMPT_FILE}" \
    bash "${TARGET}" 2>&1 >/dev/null \
    | grep -Fq 'HIJOGUCHI_CHANNEL_ID is required'
}

t23_unset_bot_mention_fails() {
  ! env -u HIJOGUCHI_BOT_MENTION HIJOGUCHI_CHANNEL_ID='TEST_CHAN' \
      HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE="${PROMPT_FILE}" \
      bash "${TARGET}" >/dev/null 2>&1
}

t24_unset_bot_mention_logs_error() {
  env -u HIJOGUCHI_BOT_MENTION HIJOGUCHI_CHANNEL_ID='TEST_CHAN' \
    HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE="${PROMPT_FILE}" \
    bash "${TARGET}" 2>&1 >/dev/null \
    | grep -Fq 'HIJOGUCHI_BOT_MENTION is required'
}

# Empty string is treated as unset (matches `:-` expansion). A plist that
# defines the var but leaves the value blank must NOT silently render a
# `chat_id=""` rule.
t25_empty_channel_id_fails() {
  ! HIJOGUCHI_CHANNEL_ID='' HIJOGUCHI_BOT_MENTION='<@TEST>' \
      HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE="${PROMPT_FILE}" \
      bash "${TARGET}" >/dev/null 2>&1
}

# --- Issue #110: idle context reset --------------------------------------
# The idle decision is exposed via HIJOGUCHI_IDLE_DECISION_ONLY=1, which prints
# RESET/KEEP and exits before any tmux/claude side effect. `now` is pinned with
# HIJOGUCHI_NOW_EPOCH so the threshold maths is fully deterministic.
HOOK="${SCRIPT_DIR}/hijoguchi-record-activity.sh"

# Stamp older than the threshold → reset the session.
# now - last = 5000 - 1000 = 4000s (66.7min) > 3600s (60min) → RESET.
t26_idle_past_threshold_resets() {
  local tmp; tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '${tmp}'" RETURN
  echo 1000 > "${tmp}"
  HIJOGUCHI_IDLE_DECISION_ONLY=1 HIJOGUCHI_IDLE_RESET_MIN=60 \
    LAST_MSG_TS_FILE="${tmp}" HIJOGUCHI_NOW_EPOCH=5000 \
    bash "${TARGET}" 2>/dev/null | grep -Fxq RESET
}

# Stamp within the threshold → keep the session alive.
t27_idle_within_threshold_keeps() {
  local tmp; tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '${tmp}'" RETURN
  echo 1000 > "${tmp}"
  HIJOGUCHI_IDLE_DECISION_ONLY=1 HIJOGUCHI_IDLE_RESET_MIN=60 \
    LAST_MSG_TS_FILE="${tmp}" HIJOGUCHI_NOW_EPOCH=2000 \
    bash "${TARGET}" 2>/dev/null | grep -Fxq KEEP
}

# Threshold 0 (opt-out) → never reset, even with an ancient stamp.
t28_optout_never_resets() {
  local tmp; tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '${tmp}'" RETURN
  echo 1 > "${tmp}"
  HIJOGUCHI_IDLE_DECISION_ONLY=1 HIJOGUCHI_IDLE_RESET_MIN=0 \
    LAST_MSG_TS_FILE="${tmp}" HIJOGUCHI_NOW_EPOCH=9999999999 \
    bash "${TARGET}" 2>/dev/null | grep -Fxq KEEP
}

# Missing state file → fail safe (keep). Happens transiently before baseline.
t29_missing_state_keeps() {
  HIJOGUCHI_IDLE_DECISION_ONLY=1 HIJOGUCHI_IDLE_RESET_MIN=60 \
    LAST_MSG_TS_FILE=/nonexistent/hijoguchi/ts HIJOGUCHI_NOW_EPOCH=9999999999 \
    bash "${TARGET}" 2>/dev/null | grep -Fxq KEEP
}

# Corrupt (non-numeric) stamp → fail safe (keep).
t30_corrupt_stamp_keeps() {
  local tmp; tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '${tmp}'" RETURN
  echo "not-a-number" > "${tmp}"
  HIJOGUCHI_IDLE_DECISION_ONLY=1 HIJOGUCHI_IDLE_RESET_MIN=60 \
    LAST_MSG_TS_FILE="${tmp}" HIJOGUCHI_NOW_EPOCH=9999999999 \
    bash "${TARGET}" 2>/dev/null | grep -Fxq KEEP
}

# Exactly at the boundary (delta == reset_min*60) → reset (>= comparison).
t31_boundary_resets() {
  local tmp; tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '${tmp}'" RETURN
  echo 1000 > "${tmp}"
  HIJOGUCHI_IDLE_DECISION_ONLY=1 HIJOGUCHI_IDLE_RESET_MIN=60 \
    LAST_MSG_TS_FILE="${tmp}" HIJOGUCHI_NOW_EPOCH=$((1000 + 60 * 60)) \
    bash "${TARGET}" 2>/dev/null | grep -Fxq RESET
}

# Hook stamps the activity file when running inside the hijoguchi session.
t32_hook_writes_when_in_session() {
  local dir; dir=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '${dir}'" RETURN
  local f="${dir}/last-message-ts"
  echo '{"hook_event_name":"UserPromptSubmit"}' \
    | CLAUDE_HUB_HIJOGUCHI_SESSION=1 CLAUDE_HUB_STATE_DIR="${dir}" \
      LAST_MSG_TS_FILE="${f}" bash "${HOOK}"
  [ -f "${f}" ] && grep -Eq '^[0-9]+$' "${f}"
}

# Hook is a no-op (no write) outside the hijoguchi session.
t33_hook_noop_without_marker() {
  local dir; dir=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '${dir}'" RETURN
  local f="${dir}/last-message-ts"
  echo '{"hook_event_name":"UserPromptSubmit"}' \
    | env -u CLAUDE_HUB_HIJOGUCHI_SESSION CLAUDE_HUB_STATE_DIR="${dir}" \
      LAST_MSG_TS_FILE="${f}" bash "${HOOK}"
  [ ! -f "${f}" ]
}

run "T1 channel ID expanded"          t1_channel_id_expanded
run "T2 no residual {{}} tokens"      t2_no_residual_tokens
run "T3 env override works"           t3_env_override
run "T4 unresolved token → exit 1"    t4_unresolved_token_fails
run "T5 missing prompt → exit 1"      t5_missing_prompt_fails
run "T6 source has no hardcoded ID"   t6_source_no_hardcoded_id
run "T7 source has {{placeholder}}"   t7_source_has_placeholder
run "T8 rendered has primary rule"    t8_rendered_has_primary_rule
run "T9 rendered has keyword list"    t9_rendered_has_keywords
run "T10 bot mention expanded"        t10_bot_mention_expanded
run "T11 default includes skip flag"  t11_default_includes_skip_flag
run "T12 unsafe=1 includes flag"      t12_unsafe_env_includes_skip_flag
run "T13 enforce=0 omits flag"        t13_enforce_env_omits_skip_flag
run "T14 unknown env omits flag"      t14_unknown_env_omits_skip_flag
run "T15 enforce mode logged"         t15_enforce_mode_logged
run "T16 unsafe mode logged"          t16_unsafe_mode_logged
run "T17 settings.json has allow/deny" t17_settings_has_allow_and_deny
run "T18 skip flag single occurrence" t18_single_flag_occurrence
run "T19 print-argv redacts prompt"   t19_print_argv_redacts_prompt
run "T20 settings deny covers bypass" t20_settings_deny_covers_bypass_vectors
run "T21 unset CHANNEL_ID exits 1"    t21_unset_channel_id_fails
run "T22 unset CHANNEL_ID logs error" t22_unset_channel_id_logs_error
run "T23 unset BOT_MENTION exits 1"   t23_unset_bot_mention_fails
run "T24 unset BOT_MENTION logs error" t24_unset_bot_mention_logs_error
run "T25 empty CHANNEL_ID exits 1"    t25_empty_channel_id_fails
run "T26 idle past threshold resets"  t26_idle_past_threshold_resets
run "T27 idle within threshold keeps" t27_idle_within_threshold_keeps
run "T28 opt-out never resets"        t28_optout_never_resets
run "T29 missing state keeps"         t29_missing_state_keeps
run "T30 corrupt stamp keeps"         t30_corrupt_stamp_keeps
run "T31 boundary resets"             t31_boundary_resets
run "T32 hook writes in session"      t32_hook_writes_when_in_session
run "T33 hook no-op without marker"   t33_hook_noop_without_marker

if [ "${fail}" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
