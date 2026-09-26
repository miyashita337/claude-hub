/**
 * Issue #360 (follow-up of #74 / #236): shared contract for turning a caught,
 * `unknown` error into text that is safe to show a Discord user (or return in
 * an internal relay-server response body).
 *
 * `err instanceof Error ? err.message : String(err)` is the recurring shape
 * of the leak: Node/Bun `Error.message` routinely embeds absolute filesystem
 * paths (`ENOENT: no such file or directory, open '/Users/<name>/...'`), and
 * `String(err)` on a non-Error throwable can carry anything at all. #74
 * closed this for the send-keys failure path and #236 closed it for the relay
 * block's outer catch in bot.ts (see `SEND_FAILURE_USER_MESSAGE` /
 * `RELAY_ERROR_USER_MESSAGE` in `./relay`); this module gives the remaining
 * call sites audited in #360 (safeReplyError, every `/session <sub>` catch,
 * the channel-post HTTP handler, and the context-budget self-heal notice) the
 * same contract without duplicating it seven times.
 *
 * The raw cause always goes to `console.error` (diagnostics only, #74's
 * observability requirement — sanitizing must not silently drop the cause).
 * The caller-supplied `message` is the only thing a user ever sees; it must
 * already be free of interpolated error content.
 */
export function logRawError(logLabel: string, err: unknown): void {
  console.error(`[${logLabel}]`, err);
}

/**
 * Pure formatter — no logging. `message` is a caller-owned, static
 * description of what failed (e.g. "❌ セッション起動に失敗しました"); the
 * result always carries the same recovery guidance as
 * `RELAY_ERROR_USER_MESSAGE` (#236) — check status, then retry — so a user
 * hitting any of these paths has one consistent next action.
 *
 * Split out from {@link sanitizedFailureNotice} (devils-advocate review of
 * #360) for callers that already logged the raw `err` themselves — bot.ts's
 * `safeReplyError` is invoked from four `.catch((err) => { console.error(...);
 * await safeReplyError(interaction, err); })` sites, so logging again inside
 * the notice builder would just double the log line for no benefit.
 */
export function buildFailureNotice(message: string): string {
  return `${message}（一時的な障害の可能性があります）。少し待って再実行するか、\`/session status\` で状態を確認してください。`;
}

/**
 * {@link buildFailureNotice} plus logging the raw `err` (never interpolated)
 * via {@link logRawError} in one call — for the common case where the catch
 * site has not logged `err` yet (every `/session <sub>` handler, the
 * compact button, the context-budget self-heal notice).
 */
export function sanitizedFailureNotice(
  logLabel: string,
  message: string,
  err: unknown
): string {
  logRawError(logLabel, err);
  return buildFailureNotice(message);
}
