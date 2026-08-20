#!/bin/bash
# Claude Code PreToolUse hook (matcher: AskUserQuestion). Issue #12 Phase 1 / #370.
#
# Forwards an AskUserQuestion prompt from a supervisor session to the Discord
# thread, waits for the user's reply, and returns the reply to Claude via a
# PreToolUse deny envelope so Claude continues without blocking on a TUI
# dialog that a Discord-only user can never see (Issue #370).
#
# Why deny instead of `updatedInput`: AskUserQuestion has no documented way to
# pre-supply an answer through its input — rewriting the input still opens the
# TUI dialog. A deny reason IS delivered to Claude as the tool result, so the
# reason text mirrors the native answered-dialog wording ("Your questions have
# been answered: ...") and Claude treats it as the user's answer, not a
# refusal.
#
# Skipping behaviour
# ------------------
# Out of a supervisor session (no relay-url file for the cwd), the hook exits
# 0 silently with no stdout — Claude sees the original tool input unchanged
# and the regular TUI dialog flow runs (Issue #12 AC-3 / Journey-AC #3).
# Unknown input shapes (no `questions[]`) fall through the same way.
#
# Relay URL discovery mirrors `progress-relay.sh`: the runtime-dir layout is
# written by SessionManager.start (`relayUrlFilePath()` in manager.ts).
#
#   $XDG_RUNTIME_DIR set: ${XDG_RUNTIME_DIR}/claude-hub-supervisor/<sanitised-cwd>.relay-url
#   $XDG_RUNTIME_DIR unset (typical macOS): /tmp/claude-hub-supervisor-<USER>/<sanitised-cwd>.relay-url

INPUT=$(cat)

# Read cwd from hook JSON. Without a cwd we have no way to find the relay URL.
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
if [ -z "$CWD" ]; then
  exit 0
fi

# Sanitise the cwd to match relayUrlFilePath() in manager.ts:
#   - strip ALL leading slashes
#   - replace any non-[A-Za-z0-9._-] with `_`
SANITISED=$(printf '%s' "$CWD" | sed -e 's|^/*||' -e 's|[^A-Za-z0-9._-]|_|g')
if [ -n "$XDG_RUNTIME_DIR" ]; then
  RUNTIME_DIR="${XDG_RUNTIME_DIR}/claude-hub-supervisor"
else
  RUNTIME_DIR="/tmp/claude-hub-supervisor-${USER:-default}"
fi
RELAY_URL_FILE="${RUNTIME_DIR}/${SANITISED}.relay-url"
if [ ! -f "$RELAY_URL_FILE" ]; then
  # Not running under a supervisor session — keep TUI behaviour unchanged.
  exit 0
fi

SUPERVISOR_RELAY_URL=$(cat "$RELAY_URL_FILE")
if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0
fi

# Derive the /ask/ endpoint from the /relay/ URL the manager wrote. Use sed
# to scope the substitution to the path segment `/relay/` only — bash's
# `${VAR/pat/repl}` replaces the FIRST `relay` anywhere in the URL, which would
# corrupt host names or threadIds containing the literal "relay" (review:
# gemini-code-assist on PR #142, comment 3179491537).
ASK_URL=$(printf '%s' "$SUPERVISOR_RELAY_URL" | sed 's|/relay/|/ask/|')

# AskUserQuestion's real input shape (Issue #370 D2, captured from a live
# transcript) is:
#   { "questions": [ { "question", "header", "multiSelect",
#                      "options": [ { "label", "description" } ] } ] }
# Single question: forward its text + options flattened to "label — description"
# strings so Discord can list the choices. Multiple questions (#443): forward
# the joined text as `question` (unchanged, used for the deny-envelope wording
# and the expiry notice) PLUS a structured `questions[]` array carrying each
# sub-question's own text + flattened options, so relay-server / bot.ts can
# post one tappable ActionRow per question instead of flattening every option
# away. Before #443 this branch dropped `options` entirely — the only way to
# answer 2+ questions was one free-text reply for the whole batch, which is
# what let an unrelated message get read as the answer to every question at
# once (see Issue #443's incident writeup).
QUESTION_COUNT=$(echo "$INPUT" | jq -r '(.tool_input.questions // []) | length' 2>/dev/null)
if [ -z "$QUESTION_COUNT" ] || [ "$QUESTION_COUNT" -eq 0 ] 2>/dev/null; then
  # Unknown / legacy shape — let the regular TUI dialog handle it.
  exit 0
fi

QUESTION_TEXT=$(echo "$INPUT" | jq -r '(.tool_input.questions // []) | map(.question // "") | join("\n")')
if [ -z "$QUESTION_TEXT" ]; then
  exit 0
fi

PAYLOAD=$(echo "$INPUT" | jq -c '
  def flatten_options: [ .[]?
    | (.label // "")
      + (if (.description // "") != "" then " — " + .description else "" end) ];
  (.tool_input.questions // []) as $qs
  | if ($qs | length) == 1 then
      { question: ($qs[0].question // ""),
        options: ($qs[0].options // [] | flatten_options) }
      | if (.options | length) == 0 then del(.options) else . end
    else
      { question: ($qs | map(.question // "") | join("\n")),
        questions: [ $qs[] | {
          question: (.question // ""),
          multiSelect: (.multiSelect // false),
          options: (.options // [] | flatten_options)
        } | if (.options | length) == 0 then del(.options) else . end ] }
    end')

# Forward to the supervisor and wait for the user's reply. The server enforces
# the real deadline; this budget only has to outlast it.
#
# Issue #416: 310s -> 21600s (6h). The server default is now 5h
# (DEFAULT_ASK_TIMEOUT_MS) because the 会長 reads the morning report on mobile
# hours after delivery, and ASK_TIMEOUT_MS can raise it up to MAX_ASK_TIMEOUT_MS
# (6h). This is set to exactly MAX/1000 so *any* configured value is covered
# without curl outliving the server's hard cap.
#
# INVARIANT (locked by relay-server.test.ts against this literal):
#   DEFAULT_ASK_TIMEOUT_MS <= --max-time * 1000 <= MAX_ASK_TIMEOUT_MS
# Below the lower bound, curl gives up first and the user's answer is wasted;
# above the upper bound, the hook hangs past any moment the server could reply.
#
# NOTE: Claude Code kills the hook at the `timeout` configured for it in
# ~/.claude/settings.json (seconds; default 600). That value must also be raised
# past this budget, or IT becomes the effective ceiling. When it does cut in, the
# hook is killed, the tool proceeds and the TUI dialog opens — which since Issue
# #423 is a wait for a human, not a fabricated answer.
RESPONSE=$(printf '%s' "$PAYLOAD" | \
  curl -s -X POST "$ASK_URL" \
    -H "Content-Type: application/json" \
    -d @- \
    --max-time 21600)
CURL_EXIT=$?

if [ $CURL_EXIT -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Network / supervisor failure: don't block Claude. Letting the original
  # AskUserQuestion run is safer than synthesising a fake answer.
  exit 0
fi

ANSWER=$(echo "$RESPONSE" | jq -r '.answer // ""' 2>/dev/null)
if [ -z "$ANSWER" ]; then
  # 504 / 499 / malformed body — fall back to TUI behaviour.
  exit 0
fi

# Deliver the reply via PreToolUse deny. The reason mirrors the wording the
# harness itself uses for an answered dialog, so Claude reads it as "the user
# answered" and continues the turn with the answer in mind.
jq -n --arg q "$QUESTION_TEXT" --arg a "$ANSWER" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("Your questions have been answered: \"" + $q + "\"=\"" + $a + "\". You can now continue with these answers in mind. (answered by the user via Discord relay)")
  }
}'
