#!/bin/bash
# Unit tests for scripts/protect-config.sh env-var guards (S8 #54).
# Run standalone: bash scripts/test-protect-config.sh
# Exits 0 on all-pass, 1 on any failure.
#
# Test case functions (tN_*) are invoked through `run "..." fn_name`.
# shellcheck disable=SC2329

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${SCRIPT_DIR}/protect-config.sh"

fail=0
run() {
  local name="$1"; shift
  if "$@"; then echo "PASS ${name}"; else echo "FAIL ${name}"; fail=1; fi
}

# Ensure a clean env baseline; individual tests re-export as needed.
unset CLAUDE_SKIP_PROTECT SUPERVISOR_RELAY_URL

# AC-3: script parses without syntax errors.
t1_syntax_check() {
  bash -n "${TARGET}"
}

# AC-2: CLAUDE_SKIP_PROTECT (any non-empty value) is rejected with exit 2.
# We assert exit code == 2 (not just non-zero) so the test catches regressions
# where a different failure code (e.g. jq's exit 4) silently satisfies the
# rejection expectation.
t2_skip_protect_rejected() {
  local out rc
  out=$(CLAUDE_SKIP_PROTECT=1 bash "${TARGET}" </dev/null 2>&1) && rc=0 || rc=$?
  [ "${rc}" -eq 2 ] && echo "${out}" | grep -Fq 'CLAUDE_SKIP_PROTECT'
}

# AC-2 variant: truthy-looking strings are also rejected (presence, not value).
t2b_skip_protect_any_value() {
  local rc
  CLAUDE_SKIP_PROTECT=yes bash "${TARGET}" </dev/null >/dev/null 2>&1 && rc=0 || rc=$?
  [ "${rc}" -eq 2 ]
}

# AC-1: External SUPERVISOR_RELAY_URL is blocked with exit 2.
t3_external_url_blocked() {
  local out rc
  out=$(SUPERVISOR_RELAY_URL='https://evil.example.com/relay' \
        bash "${TARGET}" </dev/null 2>&1) && rc=0 || rc=$?
  [ "${rc}" -eq 2 ] && echo "${out}" | grep -Fq 'SUPERVISOR_RELAY_URL'
}

# AC-1 variant: LAN IPs are NOT loopback — must be blocked with exit 2.
t3b_lan_ip_blocked() {
  local rc
  SUPERVISOR_RELAY_URL='http://192.168.1.10:3000/' \
    bash "${TARGET}" </dev/null >/dev/null 2>&1 && rc=0 || rc=$?
  [ "${rc}" -eq 2 ]
}

# AC-1 inverse: loopback URL passes the guard.
t4_loopback_allowed() {
  # Empty stdin + jq present → script's body exits 0 after the empty-input
  # early-return (added post-review to avoid jq errors on blank stdin).
  SUPERVISOR_RELAY_URL='http://localhost:3000/relay' \
    bash "${TARGET}" </dev/null >/dev/null 2>&1
}

# AC-1 inverse: 127.0.0.1 and [::1] variants also pass.
t4b_loopback_variants_allowed() {
  SUPERVISOR_RELAY_URL='ws://127.0.0.1:8080/' \
    bash "${TARGET}" </dev/null >/dev/null 2>&1 \
  && SUPERVISOR_RELAY_URL='https://[::1]/x' \
    bash "${TARGET}" </dev/null >/dev/null 2>&1
}

# AC-1 inverse: loopback URL with query string (no trailing slash) passes.
# Regression guard for the regex tightening found in review.
t4c_loopback_with_query() {
  SUPERVISOR_RELAY_URL='http://localhost:3000?token=abc' \
    bash "${TARGET}" </dev/null >/dev/null 2>&1
}

# AC-4: guard emits a log line tagged [protect-config] BLOCKED on rejection.
t5_guard_logs_on_block() {
  local out
  out=$(CLAUDE_SKIP_PROTECT=1 bash "${TARGET}" </dev/null 2>&1 || true)
  echo "${out}" | grep -qE '^\[protect-config\] BLOCKED:'
}

# Env guard fires before stdin parsing — even garbage input is rejected with
# exit 2 (not jq's exit 4 from failing to parse the non-JSON body).
t6_env_guard_fast_fail() {
  local out rc
  out=$(CLAUDE_SKIP_PROTECT=1 bash "${TARGET}" <<<'not-json garbage' 2>&1) && rc=0 || rc=$?
  [ "${rc}" -eq 2 ] && echo "${out}" | grep -Fq 'CLAUDE_SKIP_PROTECT'
}

# No env → default pass-through (exit 0) for empty stdin.
t7_passthrough_no_env() {
  unset CLAUDE_SKIP_PROTECT SUPERVISOR_RELAY_URL
  bash "${TARGET}" </dev/null >/dev/null 2>&1
}

# RW-006 regression: no bare $VAR followed by a non-ASCII byte in source.
# Uses perl slurp mode (-0777) because BSD `grep -P` is not POSIX and isn't
# compiled in on stock macOS. Test passes when perl exits non-zero (no match).
t8_rw006_braced_vars() {
  ! LC_ALL=C perl -0777 -ne \
    'exit(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/ ? 0 : 1)' "${TARGET}"
}

# Write-tool regression: any Write of tsconfig.json is blocked. Without this
# the full-file rewrite could drop strict mode silently (bypassing the Edit
# check on old_string). Legitimate tweaks must go through Edit.
t9_write_tsconfig_blocked() {
  local out rc input
  input='{"tool_name":"Write","tool_input":{"file_path":"/repo/tsconfig.json","content":"{\"compilerOptions\":{\"target\":\"ES2022\"}}"}}'
  out=$(printf '%s' "${input}" | bash "${TARGET}" 2>&1) && rc=0 || rc=$?
  [ "${rc}" -eq 2 ] && echo "${out}" | grep -Fq 'tsconfig.json'
}

# Write of pyproject.toml with [tool.ruff*] in new content is blocked.
t10_write_pyproject_ruff_blocked() {
  local out rc input
  input='{"tool_name":"Write","tool_input":{"file_path":"/repo/pyproject.toml","content":"[tool.ruff]\nline-length = 100"}}'
  out=$(printf '%s' "${input}" | bash "${TARGET}" 2>&1) && rc=0 || rc=$?
  [ "${rc}" -eq 2 ] && echo "${out}" | grep -Fq '[tool.ruff]'
}

# Edit path still works (regression). Keeps the legacy old_string check honest.
t11_edit_tsconfig_strict_still_blocked() {
  local out rc input
  input='{"tool_name":"Edit","tool_input":{"file_path":"/repo/tsconfig.json","old_string":"\"strict\": true"}}'
  out=$(printf '%s' "${input}" | bash "${TARGET}" 2>&1) && rc=0 || rc=$?
  [ "${rc}" -eq 2 ] && echo "${out}" | grep -Fq 'strict mode in tsconfig.json'
}

# Write of pyproject.toml WITHOUT [tool.ruff] (e.g. only [project] metadata)
# must pass through — we only want to block ruff-config writes, not all
# pyproject.toml edits.
t12_write_pyproject_benign_allowed() {
  local rc input
  input='{"tool_name":"Write","tool_input":{"file_path":"/repo/pyproject.toml","content":"[project]\nname=\"x\""}}'
  printf '%s' "${input}" | bash "${TARGET}" >/dev/null 2>&1 && rc=0 || rc=$?
  [ "${rc}" -eq 0 ]
}

run "T1 syntax check (AC-3)"                     t1_syntax_check
run "T2 CLAUDE_SKIP_PROTECT rejected (AC-2)"     t2_skip_protect_rejected
run "T2b any non-empty value rejected"           t2b_skip_protect_any_value
run "T3 external URL blocked (AC-1)"             t3_external_url_blocked
run "T3b LAN IP blocked"                         t3b_lan_ip_blocked
run "T4 loopback URL allowed"                    t4_loopback_allowed
run "T4b 127.0.0.1 / [::1] allowed"              t4b_loopback_variants_allowed
run "T4c loopback + query string allowed"        t4c_loopback_with_query
run "T5 log line on block (AC-4)"                t5_guard_logs_on_block
run "T6 env guard precedes stdin parse"          t6_env_guard_fast_fail
run "T7 no env → pass-through"                   t7_passthrough_no_env
run "T8 no bare \$VAR before non-ASCII"          t8_rw006_braced_vars
run "T9 Write tsconfig blocked (any content)"    t9_write_tsconfig_blocked
run "T10 Write pyproject ruff blocked"           t10_write_pyproject_ruff_blocked
run "T11 Edit tsconfig strict still blocked"     t11_edit_tsconfig_strict_still_blocked
run "T12 Write pyproject w/o ruff allowed"       t12_write_pyproject_benign_allowed

if [ "${fail}" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
