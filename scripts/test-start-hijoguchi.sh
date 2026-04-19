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

fail=0
run() {
  local name="$1"; shift
  if "$@"; then echo "PASS ${name}"; else echo "FAIL ${name}"; fail=1; fi
}

t1_channel_id_expanded() {
  HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1 | grep -Fq '1487701062205964329'
}

t2_no_residual_tokens() {
  ! HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1 | grep -Eq '\{\{[A-Z_]+\}\}'
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
  ! grep -Fq '1487701062205964329' "${PROMPT_FILE}"
}

t7_source_has_placeholder() {
  grep -Fq '{{HIJOGUCHI_CHANNEL_ID}}' "${PROMPT_FILE}"
}

# AC-1 smoke: rendered prompt still defines the primary-channel condition
# after template expansion. Catches silent deletion of Condition 1.
t8_rendered_has_primary_rule() {
  HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1 | grep -Fq 'chat_id'
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

run "T1 channel ID expanded"          t1_channel_id_expanded
run "T2 no residual {{}} tokens"      t2_no_residual_tokens
run "T3 env override works"           t3_env_override
run "T4 unresolved token → exit 1"    t4_unresolved_token_fails
run "T5 missing prompt → exit 1"      t5_missing_prompt_fails
run "T6 source has no hardcoded ID"   t6_source_no_hardcoded_id
run "T7 source has {{placeholder}}"   t7_source_has_placeholder
run "T8 rendered has primary rule"    t8_rendered_has_primary_rule
run "T9 rendered has keyword list"    t9_rendered_has_keywords

if [ "${fail}" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
