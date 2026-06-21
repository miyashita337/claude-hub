#!/bin/bash
# Unit tests for the claudeHubExit Discord mention gate (#267).
#
# Two hooks implement a MECHANICAL gate that does NOT depend on the LLM honoring
# the behavioral system-prompt rule (which broke in #267, re-breaking #230):
#
#   scripts/hijoguchi-record-channel-context.sh  (UserPromptSubmit)
#     Records, per incoming Discord chat_id, whether the message mentioned the
#     bot — into ${CLAUDE_HUB_STATE_DIR}/channel-ctx/<chat_id> (1 = mentioned).
#
#   scripts/hijoguchi-discord-gate.sh            (PreToolUse: reply/react/edit)
#     DENIES (exit 2) a Discord post when the target chat is non-primary AND the
#     last incoming message there did not mention the bot. Allows primary always
#     and non-primary only when mentioned (= #230 condition 1 / 2, mechanically).
#
# Run standalone: bash scripts/test-hijoguchi-discord-gate.sh
# Exits 0 on all-pass, 1 on any failure.
# shellcheck disable=SC2329
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RECORD="${SCRIPT_DIR}/hijoguchi-record-channel-context.sh"
GATE="${SCRIPT_DIR}/hijoguchi-discord-gate.sh"

PRIMARY="100000000000000001"      # stands in for HIJOGUCHI_CHANNEL_ID
NONPRIM="200000000000000002"      # a project / session-thread channel
BOT_MENTION="<@900000000000000009>"

fail=0
run() {
  local name="$1"; shift
  if "$@"; then echo "PASS ${name}"; else echo "FAIL ${name}"; fail=1; fi
}

# Fresh isolated state dir per invocation of the helpers.
new_state() {
  STATE="$(mktemp -d)"
  export CLAUDE_HUB_STATE_DIR="${STATE}"
}

# Build a UserPromptSubmit hook payload whose prompt is a discord channel
# envelope. $1=chat_id $2=body
prompt_payload() {
  local chat="$1" body="$2"
  local env="<channel source=\"plugin:discord:discord\" chat_id=\"${chat}\" message_id=\"m1\" user=\"u\" ts=\"t\">
${body}
</channel>"
  jq -n --arg p "${env}" '{hook_event_name:"UserPromptSubmit", prompt:$p}'
}

# Build a PreToolUse payload. $1=tool_name $2=chat_id
tool_payload() {
  local tool="$1" chat="$2"
  jq -n --arg t "${tool}" --arg c "${chat}" \
    '{hook_event_name:"PreToolUse", tool_name:$t, tool_input:{chat_id:$c, text:"x"}}'
}

ctx_file() { echo "${CLAUDE_HUB_STATE_DIR}/channel-ctx/$1"; }

# ----- record-context hook -----

# hijoguchi + non-primary + NO mention -> ctx=0
rc1_nonprimary_no_mention() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_BOT_MENTION="${BOT_MENTION}" \
    bash "${RECORD}" <<<"$(prompt_payload "${NONPRIM}" "hello supervisor tmux")" || return 1
  [ "$(cat "$(ctx_file "${NONPRIM}")" 2>/dev/null)" = "0" ]
}

# hijoguchi + non-primary + mention -> ctx=1
rc2_nonprimary_mention() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_BOT_MENTION="${BOT_MENTION}" \
    bash "${RECORD}" <<<"$(prompt_payload "${NONPRIM}" "hey ${BOT_MENTION} please look")" || return 1
  [ "$(cat "$(ctx_file "${NONPRIM}")" 2>/dev/null)" = "1" ]
}

# non-hijoguchi session -> nothing written
rc3_non_hijoguchi_noop() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=0 HIJOGUCHI_BOT_MENTION="${BOT_MENTION}" \
    bash "${RECORD}" <<<"$(prompt_payload "${NONPRIM}" "hello")" || return 1
  [ ! -e "$(ctx_file "${NONPRIM}")" ]
}

# plain (non-channel) prompt -> nothing written
rc4_non_channel_noop() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_BOT_MENTION="${BOT_MENTION}" \
    bash "${RECORD}" <<<'{"hook_event_name":"UserPromptSubmit","prompt":"just a normal prompt"}' || return 1
  [ -z "$(find "${CLAUDE_HUB_STATE_DIR}/channel-ctx" -type f 2>/dev/null)" ]
}

# record hook must always exit 0 even on garbage stdin
rc5_always_exit0() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_BOT_MENTION="${BOT_MENTION}" \
    bash "${RECORD}" <<<'not json at all'
}

# HIJOGUCHI_BOT_MENTION unset + mention tag present in body -> records 0
# (fail-closed: without the configured tag a mention cannot be confirmed, so the
# gate will later deny rather than wrongly allow).
rc6_bot_mention_unset_records_zero() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 \
    bash "${RECORD}" <<<"$(prompt_payload "${NONPRIM}" "hey ${BOT_MENTION} please look")" || return 1
  [ "$(cat "$(ctx_file "${NONPRIM}")" 2>/dev/null)" = "0" ]
}

# ----- gate hook -----

gate() { # env... ; $1=tool $2=chat ; returns hook exit code
  CLAUDE_HUB_HIJOGUCHI_SESSION="${HJ:-1}" HIJOGUCHI_CHANNEL_ID="${PRIMARY}" \
    bash "${GATE}" <<<"$(tool_payload "$1" "$2")"
}

# reply to PRIMARY -> allow (exit 0)
g1_primary_allow() {
  new_state
  gate "mcp__plugin_discord_discord__reply" "${PRIMARY}"
}

# reply to non-primary, ctx=0 (recorded, NOT mentioned) -> deny (exit 2)
g2_nonprimary_unmentioned_deny() {
  new_state
  mkdir -p "${STATE}/channel-ctx"; echo 0 > "$(ctx_file "${NONPRIM}")"
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_CHANNEL_ID="${PRIMARY}" CLAUDE_HUB_STATE_DIR="${STATE}" \
    bash "${GATE}" <<<"$(tool_payload mcp__plugin_discord_discord__reply "${NONPRIM}")"
  [ $? -eq 2 ]
}

# reply to non-primary, ctx=1 (mentioned) -> allow (exit 0)
g3_nonprimary_mentioned_allow() {
  new_state
  mkdir -p "${STATE}/channel-ctx"; echo 1 > "$(ctx_file "${NONPRIM}")"
  gate "mcp__plugin_discord_discord__reply" "${NONPRIM}"
}

# reply to non-primary, NO ctx file -> deny (fail-closed, exit 2)
g4_nonprimary_noctx_failclosed() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_CHANNEL_ID="${PRIMARY}" \
    bash "${GATE}" <<<"$(tool_payload mcp__plugin_discord_discord__reply "${NONPRIM}")"
  [ $? -eq 2 ]
}

# react to non-primary, ctx=0 -> deny (exit 2)
g5_react_nonprimary_deny() {
  new_state
  mkdir -p "${STATE}/channel-ctx"; echo 0 > "$(ctx_file "${NONPRIM}")"
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_CHANNEL_ID="${PRIMARY}" \
    bash "${GATE}" <<<"$(tool_payload mcp__plugin_discord_discord__react "${NONPRIM}")"
  [ $? -eq 2 ]
}

# non-hijoguchi session -> allow (out of scope, exit 0)
g6_non_hijoguchi_allow() {
  new_state
  HJ=0 gate "mcp__plugin_discord_discord__reply" "${NONPRIM}"
}

# non-discord tool -> allow (exit 0)
g7_other_tool_allow() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_CHANNEL_ID="${PRIMARY}" \
    bash "${GATE}" <<<'{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'
}

# empty HIJOGUCHI_CHANNEL_ID -> fail-closed deny (exit 2): the backstop must not
# silently disable itself on misconfig.
g8_primary_unset_failclosed() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_CHANNEL_ID="" CLAUDE_HUB_STATE_DIR="${STATE}" \
    bash "${GATE}" <<<"$(tool_payload mcp__plugin_discord_discord__reply "${NONPRIM}")"
  [ $? -eq 2 ]
}

# discord post tool with NO chat_id -> fail-closed deny (exit 2).
g9_missing_chatid_failclosed() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_CHANNEL_ID="${PRIMARY}" CLAUDE_HUB_STATE_DIR="${STATE}" \
    bash "${GATE}" <<<'{"hook_event_name":"PreToolUse","tool_name":"mcp__plugin_discord_discord__reply","tool_input":{"text":"x"}}'
  [ $? -eq 2 ]
}

# edit_message to non-primary, ctx=0 -> deny (exit 2) (same policy as reply/react).
g10_edit_nonprimary_deny() {
  new_state
  mkdir -p "${STATE}/channel-ctx"; echo 0 > "$(ctx_file "${NONPRIM}")"
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_CHANNEL_ID="${PRIMARY}" CLAUDE_HUB_STATE_DIR="${STATE}" \
    bash "${GATE}" <<<"$(tool_payload mcp__plugin_discord_discord__edit_message "${NONPRIM}")"
  [ $? -eq 2 ]
}

# ----- end-to-end: reproduce #267 incident then prove it is blocked -----
# Non-primary corp session-thread, no mention -> record -> gate reply -> DENY.
e1_incident_blocked() {
  new_state
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_BOT_MENTION="${BOT_MENTION}" \
    bash "${RECORD}" <<<"$(prompt_payload "${NONPRIM}" "/resume-session ~/.claude/sessions/x.tmp")" || return 1
  CLAUDE_HUB_HIJOGUCHI_SESSION=1 HIJOGUCHI_CHANNEL_ID="${PRIMARY}" \
    bash "${GATE}" <<<"$(tool_payload mcp__plugin_discord_discord__reply "${NONPRIM}")"
  [ $? -eq 2 ]
}

# ----- syntax -----
s1_record_syntax() { bash -n "${RECORD}"; }
s2_gate_syntax()   { bash -n "${GATE}"; }

run "s1 record syntax"                 s1_record_syntax
run "s2 gate syntax"                   s2_gate_syntax
run "rc1 non-primary no-mention -> 0"  rc1_nonprimary_no_mention
run "rc2 non-primary mention -> 1"     rc2_nonprimary_mention
run "rc3 non-hijoguchi no-op"          rc3_non_hijoguchi_noop
run "rc4 non-channel no-op"            rc4_non_channel_noop
run "rc5 record always exit 0"         rc5_always_exit0
run "rc6 bot-mention unset -> 0"       rc6_bot_mention_unset_records_zero
run "g1 primary allow"                 g1_primary_allow
run "g2 non-primary unmentioned deny"  g2_nonprimary_unmentioned_deny
run "g3 non-primary mentioned allow"   g3_nonprimary_mentioned_allow
run "g4 non-primary no-ctx fail-closed" g4_nonprimary_noctx_failclosed
run "g5 react non-primary deny"        g5_react_nonprimary_deny
run "g6 non-hijoguchi allow"           g6_non_hijoguchi_allow
run "g7 other tool allow"              g7_other_tool_allow
run "g8 primary-unset fail-closed"     g8_primary_unset_failclosed
run "g9 missing chat_id fail-closed"   g9_missing_chatid_failclosed
run "g10 edit_message non-primary deny" g10_edit_nonprimary_deny
run "e1 #267 incident blocked"         e1_incident_blocked

if [ "${fail}" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
fi
echo "SOME TESTS FAILED"
exit 1
