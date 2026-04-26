#!/bin/bash
# Integration tests for claudeHubExit routing rules (S5 #51 / Epic #45).
# Covers the 25-case matrix of channel × mention × sender × body × Bot-state.
#
# Run standalone:
#   bash scripts/test-hijoguchi-routing.sh              # all 25
#   bash scripts/test-hijoguchi-routing.sh --priority p0 # P0 only (12)
#   bash scripts/test-hijoguchi-routing.sh --priority p1 # P1 only (8)
#   bash scripts/test-hijoguchi-routing.sh --priority p2 # P2 only (5)
#
# Exit 0 on all-selected-pass, 1 on any failure.
#
# ## Test matrix (YAML-ish)
# # Dimensions:
# #   channel : primary | non_primary
# #   mention : self    | none
# #   sender  : owner   | other
# #   body    : keyword | clean   | mixed
# #   state   : fresh   | restart
# #
# # Expected routing (from scripts/hijoguchi-system-prompt.md):
# #   respond if ANY of:
# #     c1 = (channel == primary)
# #     c2 = (mention == self)
# #     c3 = (body contains maintenance keyword)
# #   silence otherwise.
# #
# # Test targets the *rendered system-prompt content* — we cannot deterministically
# # test live LLM behaviour, so each test asserts a structural invariant that,
# # taken together, encodes the routing rules correctly.
# #
# # Matrix (id ; priority ; dimension targeted ; assertion summary):
# #   P0-01 ; P0 ; channel=primary,encoding           ; rendered prompt has 条件1 heading
# #   P0-02 ; P0 ; channel=primary,expansion(default) ; default HIJOGUCHI_CHANNEL_ID expands
# #   P0-03 ; P0 ; channel=primary,expansion(env)     ; env override HIJOGUCHI_CHANNEL_ID expands
# #   P0-04 ; P0 ; mention=self,encoding              ; rendered prompt has 条件2 heading
# #   P0-05 ; P0 ; mention=self,expansion(env)        ; HIJOGUCHI_BOT_MENTION expands
# #   P0-06 ; P0 ; body=keyword,encoding              ; rendered prompt has 条件3 heading
# #   P0-07 ; P0 ; body=keyword,coverage              ; all 5 maintenance keywords listed
# #   P0-08 ; P0 ; silence(none of c1/c2/c3)          ; 応答しない条件 section present
# #   P0-09 ; P0 ; silence,explicit                   ; "完全に沈黙" phrase present
# #   P0-10 ; P0 ; fail-closed,missing-prompt         ; missing prompt → exit != 0
# #   P0-11 ; P0 ; fail-closed,unresolved-token       ; unresolved {{FOO}} → exit != 0
# #   P0-12 ; P0 ; state=restart(AC-5 regate)         ; two fresh renders byte-identical
# #   P1-01 ; P1 ; template-hygiene                   ; no residual {{...}} with default env
# #   P1-02 ; P1 ; source-hygiene                     ; prompt.md has no hardcoded prod ID
# #   P1-03 ; P1 ; source-placeholder                 ; prompt.md has {{HIJOGUCHI_CHANNEL_ID}}
# #   P1-04 ; P1 ; source-placeholder                 ; prompt.md has {{HIJOGUCHI_BOT_MENTION}}
# #   P1-05 ; P1 ; silence-example                    ; 他 Bot スレッド example present
# #   P1-06 ; P1 ; silence-example                    ; DM example present
# #   P1-07 ; P1 ; scope-rule                         ; 越境要求 rule present
# #   P1-08 ; P1 ; chat_id-format                     ; chat_id key referenced in 条件1
# #   P2-01 ; P2 ; side-effect-isolation              ; render-only creates no logs/
# #   P2-02 ; P2 ; render-only-exit                   ; render-only exits 0
# #   P2-03 ; P2 ; keyword-case-insensitive           ; 大文字・小文字 statement present
# #   P2-04 ; P2 ; bot-name                           ; claudeHubExit name present
# #   P2-05 ; P2 ; action-verb                        ; 応答可 action verb present
#
# Test case functions (N_*) are invoked indirectly through `run "..." fn_name`.
# shellcheck disable=SC2329

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${SCRIPT_DIR}/start-hijoguchi.sh"
PROMPT_FILE="${SCRIPT_DIR}/hijoguchi-system-prompt.md"

# Pin the prompt file so tests don't pick up a stale copy from ~/claude-hub.
export SYSTEM_PROMPT_FILE="${PROMPT_FILE}"

# Default test env: Issue #63 made HIJOGUCHI_CHANNEL_ID and
# HIJOGUCHI_BOT_MENTION required (fail-closed). Subtests that don't override
# inherit these so the script reaches its render path. Sentinel values are
# distinct from the legacy production ID so accidental leaks into source/docs
# are easy to spot.
export HIJOGUCHI_CHANNEL_ID="${HIJOGUCHI_CHANNEL_ID:-TEST_CHANNEL_DEFAULT_999}"
export HIJOGUCHI_BOT_MENTION="${HIJOGUCHI_BOT_MENTION:-<@TEST_BOT_DEFAULT_888>}"

# --- Argument parsing ---
PRIORITY="all"
while [ $# -gt 0 ]; do
  case "$1" in
    --priority)
      shift
      PRIORITY="${1:-all}"
      ;;
    --priority=*)
      PRIORITY="${1#--priority=}"
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# Normalize to uppercase so filter matches the `run P0 ...` tag form below.
PRIORITY_UPPER="$(printf '%s' "${PRIORITY}" | tr '[:lower:]' '[:upper:]')"
case "${PRIORITY_UPPER}" in
  ALL|P0|P1|P2) ;;
  *) echo "--priority must be one of: all, p0, p1, p2 (got: ${PRIORITY})" >&2; exit 2;;
esac
PRIORITY="${PRIORITY_UPPER}"

# --- Harness ---
pass=0
fail=0
skip=0

# Tracked temp paths (files + dirs) cleaned on any exit path. Using a
# script-level EXIT trap — not per-function RETURN traps — so a premature
# `set -u` / unexpected-error exit still removes the temp artefacts.
# Each entry is either a file (rm -f) or a directory (rm -rf); passing both
# forms to `rm -rf --` is safe.
TMP_PATHS=()
cleanup_tmp_paths() {
  local p
  for p in "${TMP_PATHS[@]:-}"; do
    [ -n "${p:-}" ] && rm -rf -- "$p" 2>/dev/null || true
  done
}
trap cleanup_tmp_paths EXIT
track_tmp() { TMP_PATHS+=("$1"); }

# Render the prompt once with default env; reused by read-only assertions.
render_default() {
  HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1
}

run() {
  local prio="$1"; local name="$2"; shift 2
  if [ "${PRIORITY}" != "ALL" ] && [ "${PRIORITY}" != "${prio}" ]; then
    skip=$((skip + 1))
    return 0
  fi
  if "$@"; then
    echo "PASS [${prio}] ${name}"
    pass=$((pass + 1))
  else
    echo "FAIL [${prio}] ${name}"
    fail=$((fail + 1))
  fi
}

# ==========================================================================
# P0 — Critical path (12 cases)
# ==========================================================================

P0_01_condition1_heading() {
  render_default | grep -Fq '### 条件1: Primary チャンネル内'
}

P0_02_channel_id_default_expanded() {
  # Default production ID is defined in start-hijoguchi.sh; we only assert it
  # expanded to *something* non-empty, not the literal production value (source
  # hygiene is checked separately in P1-02 / P0-11).
  local out; out="$(render_default)"
  # The 条件1 bullet line should contain an expanded chat_id in backticks.
  echo "${out}" | grep -Eq 'chat_id.*`[0-9A-Z_][0-9A-Z_-]*`'
}

P0_03_channel_id_env_override_expanded() {
  local marker="TEST_CHAN_P003"
  HIJOGUCHI_RENDER_ONLY=1 HIJOGUCHI_CHANNEL_ID="${marker}" \
    bash "${TARGET}" 2>&1 | grep -Fq "${marker}"
}

P0_04_condition2_heading() {
  render_default | grep -Fq '### 条件2: 自分宛メンション'
}

P0_05_bot_mention_env_override_expanded() {
  local marker="<@BOT_P005_ID>"
  HIJOGUCHI_RENDER_ONLY=1 HIJOGUCHI_BOT_MENTION="${marker}" \
    bash "${TARGET}" 2>&1 | grep -Fq "${marker}"
}

P0_06_condition3_heading() {
  render_default | grep -Fq '### 条件3: claude-hub 保守議題'
}

P0_07_all_five_keywords_present() {
  local out; out="$(render_default)"
  echo "${out}" | grep -Fq 'supervisor' && \
    echo "${out}" | grep -Fq 'tmux' && \
    echo "${out}" | grep -Fq 'hijoguchi' && \
    echo "${out}" | grep -Fq 'claude-hub' && \
    echo "${out}" | grep -Fq 'claudeHubExit'
}

P0_08_silence_section_present() {
  render_default | grep -Fq '## 応答しない条件'
}

P0_09_silence_explicit_phrase() {
  render_default | grep -Fq '完全に沈黙'
}

P0_10_missing_prompt_fails() {
  ! HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE=/nonexistent/hijoguchi.md \
      bash "${TARGET}" >/dev/null 2>&1
}

P0_11_unresolved_token_fails() {
  local tmpfile; tmpfile="$(mktemp)"
  track_tmp "${tmpfile}"
  printf 'chan=%s\n' '{{UNKNOWN_TOKEN_P011}}' > "${tmpfile}"
  ! HIJOGUCHI_RENDER_ONLY=1 SYSTEM_PROMPT_FILE="${tmpfile}" \
      bash "${TARGET}" >/dev/null 2>&1
}

# AC-5 Re-verification Gate: simulates a Bot restart by invoking a *fresh*
# bash process twice. If the rendered output is byte-identical, the routing
# logic survives restart (the invariant S3 #49 AC-5 asserts). Any drift —
# non-determinism in template expansion, hidden state, timestamp leakage —
# would surface here.
P0_12_restart_idempotent_ac5_regate() {
  local a b
  a="$(HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1)"
  b="$(HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" 2>&1)"
  [ "${a}" = "${b}" ] && [ -n "${a}" ]
}

# ==========================================================================
# P1 — Important secondary (8 cases)
# ==========================================================================

P1_01_no_residual_placeholders() {
  ! render_default | grep -Eq '\{\{[A-Z][A-Z0-9_]*\}\}'
}

P1_02_source_no_hardcoded_prod_channel_id() {
  # The production channel ID (17+ digit snowflake starting with 14877...)
  # must not appear in the prompt .md source — it belongs in start-hijoguchi.sh.
  ! grep -Fq '1487701062205964329' "${PROMPT_FILE}"
}

P1_03_source_has_channel_placeholder() {
  grep -Fq '{{HIJOGUCHI_CHANNEL_ID}}' "${PROMPT_FILE}"
}

P1_04_source_has_mention_placeholder() {
  grep -Fq '{{HIJOGUCHI_BOT_MENTION}}' "${PROMPT_FILE}"
}

P1_05_silence_other_bot_thread_example() {
  render_default | grep -Fq '他 Bot スレッド'
}

P1_06_silence_dm_example() {
  render_default | grep -Fq 'DM'
}

P1_07_scope_boundary_rule() {
  render_default | grep -Fq '越境要求'
}

P1_08_chat_id_key_in_condition1() {
  # The 条件1 description must reference `chat_id` so the LLM can correlate
  # the rule with the message-format framing at the top of the prompt.
  render_default | grep -Fq 'chat_id'
}

# ==========================================================================
# P2 — Supplementary (5 cases)
# ==========================================================================

P2_01_render_only_no_log_dir_side_effect() {
  # Run render-only in an isolated HOME so any accidental mkdir -p of
  # ~/claude-hub/logs shows up as an empty temp directory.
  local tmphome; tmphome="$(mktemp -d)"
  track_tmp "${tmphome}"
  HOME="${tmphome}" HIJOGUCHI_RENDER_ONLY=1 \
    SYSTEM_PROMPT_FILE="${PROMPT_FILE}" bash "${TARGET}" >/dev/null 2>&1
  # logs/ dir must NOT have been created under the fake HOME.
  [ ! -d "${tmphome}/claude-hub/logs" ]
}

P2_02_render_only_exit_zero() {
  HIJOGUCHI_RENDER_ONLY=1 bash "${TARGET}" >/dev/null 2>&1
}

P2_03_keyword_case_insensitive_statement() {
  render_default | grep -Fq '大文字・小文字を区別しない'
}

P2_04_bot_name_claudehubexit_present() {
  render_default | grep -Fq 'claudeHubExit'
}

P2_05_action_verb_respond_allowed() {
  render_default | grep -Fq '応答可'
}

# --- Runner ---
run P0 "P0-01 condition1 heading"                P0_01_condition1_heading
run P0 "P0-02 channel_id default expanded"       P0_02_channel_id_default_expanded
run P0 "P0-03 channel_id env override expanded"  P0_03_channel_id_env_override_expanded
run P0 "P0-04 condition2 heading"                P0_04_condition2_heading
run P0 "P0-05 bot_mention env override expanded" P0_05_bot_mention_env_override_expanded
run P0 "P0-06 condition3 heading"                P0_06_condition3_heading
run P0 "P0-07 all 5 keywords present"            P0_07_all_five_keywords_present
run P0 "P0-08 silence section present"           P0_08_silence_section_present
run P0 "P0-09 silence explicit phrase"           P0_09_silence_explicit_phrase
run P0 "P0-10 missing prompt fails"              P0_10_missing_prompt_fails
run P0 "P0-11 unresolved token fails"            P0_11_unresolved_token_fails
run P0 "P0-12 restart idempotent (AC-5 regate)"  P0_12_restart_idempotent_ac5_regate

run P1 "P1-01 no residual {{}} placeholders"     P1_01_no_residual_placeholders
run P1 "P1-02 source no hardcoded prod id"       P1_02_source_no_hardcoded_prod_channel_id
run P1 "P1-03 source has channel placeholder"    P1_03_source_has_channel_placeholder
run P1 "P1-04 source has mention placeholder"    P1_04_source_has_mention_placeholder
run P1 "P1-05 silence other-bot-thread example"  P1_05_silence_other_bot_thread_example
run P1 "P1-06 silence DM example"                P1_06_silence_dm_example
run P1 "P1-07 scope boundary rule"               P1_07_scope_boundary_rule
run P1 "P1-08 chat_id key in condition1"         P1_08_chat_id_key_in_condition1

run P2 "P2-01 render-only no log-dir side effect" P2_01_render_only_no_log_dir_side_effect
run P2 "P2-02 render-only exit 0"                 P2_02_render_only_exit_zero
run P2 "P2-03 keyword case-insensitive statement" P2_03_keyword_case_insensitive_statement
run P2 "P2-04 bot name claudeHubExit present"     P2_04_bot_name_claudehubexit_present
run P2 "P2-05 action verb 応答可 present"          P2_05_action_verb_respond_allowed

total=$((pass + fail))
echo "----------------------------------------"
echo "Priority filter: ${PRIORITY}"
echo "PASS: ${pass}/${total}  FAIL: ${fail}  SKIP: ${skip}"

if [ "${fail}" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
