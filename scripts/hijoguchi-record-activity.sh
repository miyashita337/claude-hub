#!/bin/bash
# UserPromptSubmit hook: stamp the time of the latest Discord message into the
# claudeHubExit idle-reset state file (Issue #110).
#
# Registered in .claude/settings.json and therefore loaded by every Claude Code
# session whose cwd is ~/claude-hub. UserPromptSubmit has no matcher support
# (Claude Code silently ignores one — it fires on every prompt), so scoping is
# done here in-code: the body is gated on CLAUDE_HUB_HIJOGUCHI_SESSION so only
# the watchdog-spawned claudeHubExit session writes the stamp. An ordinary
# `claude` session a developer opens in ~/claude-hub falls through to `exit 0`
# after a single cheap env check and never keeps the watchdog's idle timer warm.
#
# Always exits 0: a hook that blocked or errored on the prompt path would be
# worse than a missed stamp (the watchdog just fails safe and keeps the
# session). See scripts/start-hijoguchi.sh for the consuming watchdog loop.
set -u

# Drain stdin (Claude passes hook JSON) so the producer never blocks on a pipe.
cat >/dev/null 2>&1 || true

# Scope to the hijoguchi session only.
[ "${CLAUDE_HUB_HIJOGUCHI_SESSION:-0}" = "1" ] || exit 0

STATE_DIR="${CLAUDE_HUB_STATE_DIR:-${HOME}/.claude-hub-state}"
TS_FILE="${LAST_MSG_TS_FILE:-${STATE_DIR}/last-message-ts}"

mkdir -p "${STATE_DIR}" 2>/dev/null
date +%s > "${TS_FILE}" 2>/dev/null || true
exit 0
