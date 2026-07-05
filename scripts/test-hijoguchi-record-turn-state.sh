#!/bin/bash
# Unit tests for the claudeHubExit turn-state producer (#312).
#
#   scripts/hijoguchi-record-turn-state.sh
#     UserPromptSubmit → bot-status.json state=processing (+ gate_silenced
#                        prediction for non-primary non-mention messages)
#     Stop             → bot-status.json state=idle (chat ctx carried over)
#     PostToolUse      → touch heartbeat (mtime advances)
#
# Run standalone: bash scripts/test-hijoguchi-record-turn-state.sh
# Exits 0 on all-pass, 1 on any failure.
# shellcheck disable=SC2329
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRODUCER="${SCRIPT_DIR}/hijoguchi-record-turn-state.sh"

PRIMARY="100000000000000001"
NONPRIM="200000000000000002"
BOT_MENTION="<@900000000000000009>"

fail=0
run() {
  local name="$1"; shift
  if "$@"; then echo "PASS ${name}"; else echo "FAIL ${name}"; fail=1; fi
}

new_state() {
  STATE="$(mktemp -d)"
  export CLAUDE_HUB_STATE_DIR="${STATE}"
}

status_file() { echo "${CLAUDE_HUB_STATE_DIR}/bot-status.json"; }
heartbeat_file() { echo "${CLAUDE_HUB_STATE_DIR}/heartbeat"; }

# UserPromptSubmit payload with a Discord channel envelope. $1=chat_id $2=body
ups_payload() {
  local chat="$1" body="$2"
  local env="<channel source=\"plugin:discord:discord\" chat_id=\"${chat}\" message_id=\"m1\" user=\"u\" ts=\"t\">
${body}
</channel>"
  jq -n --arg p "${env}" '{hook_event_name:"UserPromptSubmit", prompt:$p}'
}

stop_payload() { jq -n '{hook_event_name:"Stop"}'; }
posttool_payload() { jq -n '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_response:{}}'; }

invoke() {
  # $1=payload; remaining env is inherited from the caller's exports.
  printf '%s' "$1" | CLAUDE_HUB_HIJOGUCHI_SESSION=1 \
    HIJOGUCHI_CHANNEL_ID="${PRIMARY}" HIJOGUCHI_BOT_MENTION="${BOT_MENTION}" \
    bash "${PRODUCER}"
}

jget() { jq -r "$1" "$(status_file)" 2>/dev/null; }

# ----- scope -----

t_scope_off_writes_nothing() {
  new_state
  printf '%s' "$(ups_payload "${PRIMARY}" "hello")" | CLAUDE_HUB_HIJOGUCHI_SESSION=0 \
    bash "${PRODUCER}" || return 1
  [ ! -e "$(status_file)" ] && [ ! -e "$(heartbeat_file)" ]
}
run "scope: env!=1 writes nothing" t_scope_off_writes_nothing

# ----- UserPromptSubmit -----

t_ups_primary_processing() {
  new_state
  invoke "$(ups_payload "${PRIMARY}" "hello")" || return 1
  [ "$(jget .state)" = "processing" ] \
    && [ "$(jget .chat_id)" = "${PRIMARY}" ] \
    && [ "$(jget .mentioned)" = "false" ] \
    && [ "$(jget .last_outcome)" = "null" ] \
    && jget .since | grep -qE '^[0-9]+$'
}
run "UPS: primary message → processing, no gate_silenced" t_ups_primary_processing

t_ups_nonprimary_mentioned() {
  new_state
  invoke "$(ups_payload "${NONPRIM}" "hey ${BOT_MENTION} please")" || return 1
  [ "$(jget .state)" = "processing" ] \
    && [ "$(jget .mentioned)" = "true" ] \
    && [ "$(jget .last_outcome)" = "null" ]
}
run "UPS: non-primary + mention → processing, no gate_silenced" t_ups_nonprimary_mentioned

t_ups_nonprimary_unmentioned_silenced() {
  new_state
  invoke "$(ups_payload "${NONPRIM}" "no mention here")" || return 1
  [ "$(jget .state)" = "processing" ] \
    && [ "$(jget .chat_id)" = "${NONPRIM}" ] \
    && [ "$(jget .mentioned)" = "false" ] \
    && [ "$(jget .last_outcome)" = "gate_silenced" ]
}
run "UPS: non-primary no-mention → last_outcome=gate_silenced" t_ups_nonprimary_unmentioned_silenced

t_ups_non_discord_prompt() {
  new_state
  local payload
  payload="$(jq -n '{hook_event_name:"UserPromptSubmit", prompt:"plain local prompt"}')"
  invoke "${payload}" || return 1
  [ "$(jget .state)" = "processing" ] \
    && [ "$(jget .chat_id)" = "null" ] \
    && [ "$(jget .mentioned)" = "null" ] \
    && [ "$(jget .last_outcome)" = "null" ]
}
run "UPS: non-Discord prompt → processing with null chat ctx" t_ups_non_discord_prompt

# ----- Stop -----

t_stop_after_processing() {
  new_state
  invoke "$(ups_payload "${PRIMARY}" "hello")" || return 1
  invoke "$(stop_payload)" || return 1
  [ "$(jget .state)" = "idle" ] \
    && [ "$(jget .chat_id)" = "${PRIMARY}" ] \
    && [ "$(jget .last_outcome)" = "completed" ]
}
run "Stop: after processing → idle, ctx carried, completed" t_stop_after_processing

t_stop_keeps_gate_silenced() {
  new_state
  invoke "$(ups_payload "${NONPRIM}" "no mention")" || return 1
  invoke "$(stop_payload)" || return 1
  [ "$(jget .state)" = "idle" ] \
    && [ "$(jget .last_outcome)" = "gate_silenced" ]
}
run "Stop: after silenced turn → idle, gate_silenced kept" t_stop_keeps_gate_silenced

t_stop_without_prior_record() {
  new_state
  invoke "$(stop_payload)" || return 1
  [ "$(jget .state)" = "idle" ] \
    && [ "$(jget .chat_id)" = "null" ] \
    && [ "$(jget .last_outcome)" = "completed" ]
}
run "Stop: no prior record → well-formed idle record" t_stop_without_prior_record

t_stop_with_corrupt_record() {
  new_state
  mkdir -p "${CLAUDE_HUB_STATE_DIR}"
  printf 'not json' > "$(status_file)"
  invoke "$(stop_payload)" || return 1
  [ "$(jget .state)" = "idle" ] && [ "$(jget .last_outcome)" = "completed" ]
}
run "Stop: corrupt prior record → recovers with idle record" t_stop_with_corrupt_record

# ----- PostToolUse (heartbeat) -----

t_heartbeat_touch_and_advance() {
  new_state
  invoke "$(posttool_payload)" || return 1
  [ -e "$(heartbeat_file)" ] || return 1
  local m1 m2
  m1="$(stat -f %m "$(heartbeat_file)" 2>/dev/null || stat -c %Y "$(heartbeat_file)")"
  sleep 1
  invoke "$(posttool_payload)" || return 1
  m2="$(stat -f %m "$(heartbeat_file)" 2>/dev/null || stat -c %Y "$(heartbeat_file)")"
  [ "${m2}" -gt "${m1}" ]
}
run "PostToolUse: heartbeat created and mtime advances" t_heartbeat_touch_and_advance

t_posttool_does_not_touch_status() {
  new_state
  invoke "$(ups_payload "${PRIMARY}" "hello")" || return 1
  local before after
  before="$(cat "$(status_file)")"
  invoke "$(posttool_payload)" || return 1
  after="$(cat "$(status_file)")"
  [ "${before}" = "${after}" ]
}
run "PostToolUse: bot-status.json untouched" t_posttool_does_not_touch_status

# ----- robustness -----

t_bad_json_exits_zero() {
  new_state
  printf 'garbage not json' | CLAUDE_HUB_HIJOGUCHI_SESSION=1 bash "${PRODUCER}"
}
run "robustness: garbage stdin → exit 0" t_bad_json_exits_zero

t_atomic_no_temp_leftover() {
  new_state
  invoke "$(ups_payload "${PRIMARY}" "hello")" || return 1
  invoke "$(stop_payload)" || return 1
  ! ls "${CLAUDE_HUB_STATE_DIR}"/.bot-status.* >/dev/null 2>&1
}
run "atomic: no temp files left behind" t_atomic_no_temp_leftover

exit "${fail}"
