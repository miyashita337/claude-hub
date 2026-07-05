#!/bin/bash
# Turn-state producer for the claudeHubExit (hijoguchi) Bot session (#312).
#
# One script, three hook events (dispatched on hook_event_name):
#
#   UserPromptSubmit → bot-status.json {state:"processing", since, chat_id,
#                      mentioned, last_outcome} — a turn has started. When the
#                      incoming Discord message targets a non-primary channel
#                      without an @mention, last_outcome:"gate_silenced" is
#                      pre-recorded (the PreToolUse gate will deny any reply,
#                      so the turn is intentionally silent; Mac-side log only).
#   Stop             → bot-status.json {state:"idle", ...} — the turn ended.
#                      chat_id / mentioned are carried over from the processing
#                      record; last_outcome becomes "completed" unless the turn
#                      was gate-silenced (then "gate_silenced" is kept).
#   PostToolUse      → touch heartbeat — mtime = last in-turn progress. This is
#                      what lets a reader distinguish a long-but-alive turn
#                      (heartbeat advancing) from a hung one.
#
# FAILSAFE — readers MUST NOT trust `state` alone (push-and-trust is the
# RW-023 failure shape): if the session crashes mid-turn, Stop never fires and
# `state:"processing"` sticks forever. Any consumer (the watchdog hang/dead
# judge, #313) must AND this file with (a) file mtime freshness / heartbeat
# mtime and (b) liveness of the Bot process before concluding anything.
#
# Registered in .claude/settings.json (UserPromptSubmit / Stop / PostToolUse).
# UserPromptSubmit and Stop have no matcher support and PostToolUse is matched
# broadly, so scoping is done in-code via CLAUDE_HUB_HIJOGUCHI_SESSION=1: an
# ordinary `claude` session opened in ~/claude-hub exits after one cheap env
# check and never writes Bot state. State lives in ~/.claude-hub-state/ (Bot
# dir, NOT a HOME-global file — RW-058: never let one session's state hook
# leak into every session on the machine).
#
# ALWAYS exits 0: a producer that blocked the prompt/tool path would be worse
# than a missed status write (readers fail safe on stale/missing files).
set -u

# Drain stdin first (Claude passes hook JSON) so the producer never blocks.
INPUT="$(cat 2>/dev/null)" || exit 0

# Scope to the hijoguchi session only.
[ "${CLAUDE_HUB_HIJOGUCHI_SESSION:-0}" = "1" ] || exit 0

STATE_DIR="${CLAUDE_HUB_STATE_DIR:-${HOME}/.claude-hub-state}"
STATUS_FILE="${STATE_DIR}/bot-status.json"
HEARTBEAT_FILE="${STATE_DIR}/heartbeat"

EVENT="$(printf '%s' "${INPUT}" | jq -r '.hook_event_name // empty' 2>/dev/null)" || exit 0
[ -n "${EVENT}" ] || exit 0

mkdir -p "${STATE_DIR}" 2>/dev/null || exit 0
NOW="$(date +%s)"

# Atomic publish (temp + mv, same shape as hijoguchi-record-channel-context.sh)
# so a reader never sees a torn JSON document. $1 = JSON body.
publish_status() {
  local tmp="${STATE_DIR}/.bot-status.$$"
  if printf '%s\n' "$1" > "${tmp}" 2>/dev/null; then
    mv -f "${tmp}" "${STATUS_FILE}" 2>/dev/null || rm -f "${tmp}" 2>/dev/null || true
  else
    rm -f "${tmp}" 2>/dev/null || true
  fi
}

case "${EVENT}" in
  UserPromptSubmit)
    PROMPT="$(printf '%s' "${INPUT}" | jq -r '.prompt // empty' 2>/dev/null)" || PROMPT=""
    CHAT_ID=""
    MENTIONED=""   # "" = not a Discord-envelope prompt → recorded as null
    OUTCOME=""
    case "${PROMPT}" in
      *'source="plugin:discord:discord"'*)
        # Same envelope parsing as hijoguchi-record-channel-context.sh.
        CHAT_ID="$(printf '%s' "${PROMPT}" | grep -oE 'chat_id="[0-9]+"' | head -1 | tr -dc '0-9')"
        MENTIONED=0
        BOT_MENTION="${HIJOGUCHI_BOT_MENTION:-}"
        if [ -n "${BOT_MENTION}" ]; then
          case "${PROMPT}" in
            *"${BOT_MENTION}"*) MENTIONED=1 ;;
          esac
        fi
        # Non-primary + not mentioned = the gate will silence this turn. An
        # unset HIJOGUCHI_CHANNEL_ID also lands here: the gate fails closed in
        # that configuration, so "silenced" is the truthful prediction.
        if [ -n "${CHAT_ID}" ] && [ "${MENTIONED}" != "1" ] \
           && [ "${CHAT_ID}" != "${HIJOGUCHI_CHANNEL_ID:-}" ]; then
          OUTCOME="gate_silenced"
        fi
        ;;
    esac
    BODY="$(jq -n --argjson since "${NOW}" \
      --arg chat_id "${CHAT_ID}" --arg mentioned "${MENTIONED}" --arg outcome "${OUTCOME}" \
      '{state: "processing", since: $since,
        chat_id: (if $chat_id == "" then null else $chat_id end),
        mentioned: (if $mentioned == "" then null else $mentioned == "1" end),
        last_outcome: (if $outcome == "" then null else $outcome end)}' 2>/dev/null)" || exit 0
    publish_status "${BODY}"
    ;;
  Stop)
    PREV="$(cat "${STATUS_FILE}" 2>/dev/null || true)"
    if printf '%s' "${PREV}" | jq -e 'type == "object"' >/dev/null 2>&1; then
      BODY="$(printf '%s' "${PREV}" | jq --argjson since "${NOW}" \
        '.state = "idle" | .since = $since
         | .last_outcome = (if .last_outcome == "gate_silenced"
                            then "gate_silenced" else "completed" end)' 2>/dev/null)" || exit 0
    else
      # No / corrupt processing record (e.g. state dir wiped mid-turn): still
      # publish a well-formed idle record rather than nothing.
      BODY="$(jq -n --argjson since "${NOW}" \
        '{state: "idle", since: $since, chat_id: null, mentioned: null,
          last_outcome: "completed"}' 2>/dev/null)" || exit 0
    fi
    publish_status "${BODY}"
    ;;
  PostToolUse)
    # mtime-only heartbeat: proof of in-turn progress for the hang judge.
    touch "${HEARTBEAT_FILE}" 2>/dev/null || true
    ;;
esac
exit 0
