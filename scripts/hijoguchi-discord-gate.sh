#!/bin/bash
# PreToolUse hook: the ENFORCING half of the claudeHubExit mechanical mention
# gate (#267). DENIES (exit 2) a Discord post tool (reply / react / edit) when
# the target chat is NOT the primary channel AND the last incoming message there
# did not mention the bot. This mechanically enforces #230 (respond only in the
# primary channel or when @mentioned) WITHOUT depending on the LLM honoring the
# behavioral system-prompt rule — which is exactly what failed in #267 (the
# launchd claudeHubExit reacted + replied to a non-mention message inside a
# Channel-Supervisor session thread).
#
# Mention context is written per chat_id by scripts/hijoguchi-record-channel-
# context.sh (UserPromptSubmit). PreToolUse deny is a documented, deterministic
# mechanism (exit 2 blocks the tool call), unlike UserPromptSubmit suppression.
#
# Registered in .claude/settings.json (PreToolUse, matcher = the discord post
# tools). Scoped in-code to CLAUDE_HUB_HIJOGUCHI_SESSION=1.
#
# Decision: exit 0 = allow, exit 2 = deny (stderr reason is surfaced to Claude).
set -u

INPUT="$(cat 2>/dev/null)" || exit 0

# Out of scope: only gate the dedicated claudeHubExit session.
[ "${CLAUDE_HUB_HIJOGUCHI_SESSION:-0}" = "1" ] || exit 0

TOOL="$(printf '%s' "${INPUT}" | jq -r '.tool_name // empty' 2>/dev/null)" || exit 0
case "${TOOL}" in
  mcp__plugin_discord_discord__reply|mcp__plugin_discord_discord__react|mcp__plugin_discord_discord__edit_message) : ;;
  *) exit 0 ;;  # not a Discord post tool → nothing to gate
esac

CHAT_ID="$(printf '%s' "${INPUT}" | jq -r '.tool_input.chat_id // empty' 2>/dev/null)"
# No target chat → cannot classify a Discord post → fail-closed DENY. reply /
# react / edit_message all require chat_id, so a legitimate call always has one;
# a call without it would fail anyway, so denying loses no real functionality
# while closing a "no chat_id ⇒ allow" bypass.
if [ -z "${CHAT_ID}" ]; then
  echo "[hijoguchi-gate] BLOCKED ${TOOL}: missing chat_id (cannot classify; fail-closed)." >&2
  exit 2
fi

PRIMARY="${HIJOGUCHI_CHANNEL_ID:-}"
# Misconfigured (primary unknown): fail-closed DENY rather than silently
# disabling the backstop — a silent fail-open would let #267 recur unnoticed.
# start-hijoguchi.sh refuses to launch without this env AND forwards it via the
# `env` prefix, so this branch is defensive; if it ever fires, claudeHubExit goes
# (loudly) silent until the env is fixed, which is strictly preferred over a
# silent return to the buggy behaviour.
if [ -z "${PRIMARY}" ]; then
  echo "[hijoguchi-gate] BLOCKED ${TOOL}: HIJOGUCHI_CHANNEL_ID unset (fail-closed backstop)." >&2
  exit 2
fi

# Primary channel → always allowed (#230 condition 1).
[ "${CHAT_ID}" = "${PRIMARY}" ] && exit 0

# Non-primary → allowed only if the last incoming message there mentioned the
# bot (#230 condition 2). Missing record = fail-closed DENY.
STATE_DIR="${CLAUDE_HUB_STATE_DIR:-${HOME}/.claude-hub-state}"
MENTIONED="$(cat "${STATE_DIR}/channel-ctx/${CHAT_ID}" 2>/dev/null || true)"
if [ "${MENTIONED}" = "1" ]; then
  exit 0
fi

echo "[hijoguchi-gate] BLOCKED ${TOOL} to a non-primary channel without an @mention (#267 mechanical gate; reply only in the primary channel or when mentioned)." >&2
exit 2
