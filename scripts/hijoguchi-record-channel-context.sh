#!/bin/bash
# UserPromptSubmit hook: record, per incoming Discord chat_id, whether the
# message mentioned the claudeHubExit bot. Half of the MECHANICAL mention gate
# (#267) that replaces the behavioral system-prompt rule which re-broke #230.
#
# The companion PreToolUse hook (scripts/hijoguchi-discord-gate.sh) reads these
# records to DENY a reply/react in a non-primary channel that was not mentioned.
# We split recording (here) from denying (there) because UserPromptSubmit
# blocking of `--channels`-injected prompts is not a documented guarantee, but
# PreToolUse deny is — so the reliable mechanical decision happens at PreToolUse,
# and this hook only needs to FIRE (which it provably does — the sibling
# idle-stamp hook relies on the same path) and write state.
#
# Registered in .claude/settings.json (UserPromptSubmit, no matcher → fires on
# every prompt). Scoped in-code to CLAUDE_HUB_HIJOGUCHI_SESSION=1 so an ordinary
# `claude` opened in ~/claude-hub never writes gate state. ALWAYS exits 0: a
# failure here must never block the prompt path (fail-safe; the gate hook is the
# enforcing layer and is fail-closed on a MISSING record).
set -u

# Drain stdin first so the producer never blocks, capturing it for parsing.
INPUT="$(cat 2>/dev/null)" || exit 0

# Scope to the hijoguchi session only.
[ "${CLAUDE_HUB_HIJOGUCHI_SESSION:-0}" = "1" ] || exit 0

STATE_DIR="${CLAUDE_HUB_STATE_DIR:-${HOME}/.claude-hub-state}"
CTX_DIR="${STATE_DIR}/channel-ctx"

# Extract the prompt text (UserPromptSubmit payload `.prompt`). Bad/missing JSON
# is non-fatal: just nothing to record.
PROMPT="$(printf '%s' "${INPUT}" | jq -r '.prompt // empty' 2>/dev/null)" || exit 0
[ -n "${PROMPT}" ] || exit 0

# Only act on a Discord channel envelope injected by the plugin transport, i.e.
#   <channel source="plugin:discord:discord" chat_id="..." ...>
case "${PROMPT}" in
  *'source="plugin:discord:discord"'*) : ;;
  *) exit 0 ;;
esac

# Pull the chat_id (Discord snowflake) out of the envelope tag.
CHAT_ID="$(printf '%s' "${PROMPT}" | grep -oE 'chat_id="[0-9]+"' | head -1 | tr -dc '0-9')"
[ -n "${CHAT_ID}" ] || exit 0

# Mentioned iff the body contains the bot's mention tag (HIJOGUCHI_BOT_MENTION,
# e.g. "<@123...>"). Empty env → treat as not-mentioned (fail-closed: the gate
# will then require primary or deny). The `case` pattern is a quoted substring
# match; the tag is "<@<digits>>", none of which are shell glob metacharacters
# (* ? [ ]), so it cannot match too broadly.
MENTIONED=0
BOT_MENTION="${HIJOGUCHI_BOT_MENTION:-}"
if [ -n "${BOT_MENTION}" ]; then
  case "${PROMPT}" in
    *"${BOT_MENTION}"*) MENTIONED=1 ;;
  esac
fi

mkdir -p "${CTX_DIR}" 2>/dev/null || exit 0
# Atomic publish (temp + mv) so the gate never reads a torn value. This records
# only the MOST RECENT message per chat_id; the --channels plugin enqueues and
# delivers messages serially (one prompt → one turn) and this hook fires at
# submit time, so the record reflects the message being handled in the current
# turn. Cross-message interleaving on one chat_id is therefore not expected.
TMP="${CTX_DIR}/.${CHAT_ID}.$$"
if printf '%s' "${MENTIONED}" > "${TMP}" 2>/dev/null; then
  mv -f "${TMP}" "${CTX_DIR}/${CHAT_ID}" 2>/dev/null || rm -f "${TMP}" 2>/dev/null || true
fi
exit 0
