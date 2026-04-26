/**
 * Detect leading `/<command>` patterns (Claude Code TUI slash command style)
 * at message start and strip the leading `/` so the TUI doesn't enter
 * slash-picker mode.
 *
 * Issue #86: Forwarding `/<typo>` via tmux send-keys puts Claude Code's Ink
 * TUI into the slash-command picker. If the command is a typo
 * (e.g. `/hanle-review`) the picker stays open silently, the relay queue
 * hangs until RELAY_TIMEOUT_MS, and the bot looks idle.
 *
 * Discord-side slash commands handled by this bot are limited to `/session`,
 * which is already filtered out as `Events.InteractionCreate`. By the time a
 * `/<word>` message reaches `Events.MessageCreate`, the user's slash command
 * is either a typo or an attempt to invoke a Claude Code command from
 * Discord (which isn't supported anyway). Strip-and-forward is the safest
 * recovery: the user's intent reaches Claude as natural language.
 *
 * The match is intentionally narrow: a path like `/usr/bin/ls` or
 * `/Users/x/foo` does NOT match because the first token is followed by `/`,
 * not whitespace or end-of-string.
 */
const SLASH_PREFIX_RE = /^\/[A-Za-z][A-Za-z0-9_-]*(?:\s|$)/;

export function looksLikeSlashCommand(text: string): boolean {
  return SLASH_PREFIX_RE.test(text);
}

export function stripLeadingSlash(text: string): string {
  // looksLikeSlashCommand guarantees a leading `/`, so slice(1) is a
  // direct char-drop without the cost of a regex compile (PR #115 nitpick).
  return looksLikeSlashCommand(text) ? text.slice(1) : text;
}
