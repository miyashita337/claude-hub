import { notifyPushover } from "./notify-pushover";
import { TMUX_SOCKET } from "./tmux";

/**
 * Context handed to the `onDialogStuck` callback (Issue #12).
 *
 * Produced by two paths inside {@link import("./relay").relayMessage}:
 *  - the dialog watchdog, when a *known* dialog family resists auto-accept
 *    (`kind` is the detected {@link import("./dialog-detect").DialogKind})
 *  - the stall timer, when the relay produces no response for too long and no
 *    known dialog matched — i.e. an *unknown* dialog (`kind: "stall"`)
 *
 * `tmuxSessionName` lets the heartbeat tell the user exactly which session to
 * `tmux attach -t` to unblock manually.
 */
export interface DialogStuckInfo {
  kind: string;
  line: string;
  tmuxSessionName: string;
}

/** Minimal slice of a discord.js ThreadChannel we depend on (keeps this unit
 *  testable without constructing a real Discord client). */
export interface HeartbeatThread {
  send(content: string): Promise<unknown>;
}

export interface DialogStuckHandlerOptions {
  /** Injectable pager — defaults to {@link notifyPushover}. */
  pushover?: (title: string, message: string) => Promise<boolean>;
}

function buildMessage(info: DialogStuckInfo): string {
  const label =
    info.kind === "stall"
      ? "応答待ちでブロック中"
      : `ダイアログ検出 (${info.kind})、手動操作要求`;
  return [
    `⚠️ Claude Code が${label}です。`,
    "tmux attach して対応してください:",
    "```",
    // Use the actual supervisor socket so the attach command works even when
    // SUPERVISOR_TMUX_SOCKET is customised (TMUX_SOCKET is validated in tmux.ts).
    `tmux -L ${TMUX_SOCKET} attach -t ${info.tmuxSessionName}`,
    "```",
    // Escape backticks so a captured terminal line can't break out of the
    // Discord inline code span (the line is arbitrary TUI output).
    info.line ? `検出行: \`${info.line.replace(/`/g, "'")}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the `onDialogStuck` callback for a Discord thread. The returned handler
 * posts a heartbeat to the thread *and* fires a best-effort Pushover page so a
 * phone notification lands. Both legs are best-effort: a failure in one is
 * logged and never prevents the other, and the handler never throws (the relay
 * loop must not be broken by a paging error).
 */
export function buildDialogStuckHandler(
  thread: HeartbeatThread,
  options?: DialogStuckHandlerOptions
): (info: DialogStuckInfo) => Promise<void> {
  const pushover = options?.pushover ?? notifyPushover;

  return async (info: DialogStuckInfo): Promise<void> => {
    const message = buildMessage(info);

    // Both legs run concurrently and are independently isolated: a failure in
    // one is logged and never prevents the other, and the handler never
    // throws (the relay loop must not break on a paging error). `.then` wraps
    // pushover so an injected impl that throws synchronously is also caught.
    await Promise.all([
      // `.then` wraps send() so a synchronous throw (not just a rejected
      // promise) is also caught here and can never escape Promise.all — the
      // handler's "never throws" contract must hold for the relay loop.
      Promise.resolve()
        .then(() => thread.send(message))
        .catch((err) =>
          console.warn("[DialogStuck] failed to post Discord heartbeat:", err)
        ),
      Promise.resolve()
        .then(() =>
          pushover(
            "Claude Code: 手動操作要求",
            `${info.tmuxSessionName} (${info.kind})`
          )
        )
        .catch((err) =>
          console.warn("[DialogStuck] pushover page failed:", err)
        ),
    ]);
  };
}

/**
 * Wrap an `onDialogStuck` handler so it pages at most once per relay turn.
 *
 * Two independent triggers feed the handler — the dialog watchdog (known
 * dialog) and the stall timer (unknown dialog). For a persistent known dialog
 * both would otherwise fire, double-posting to Discord and risking a Pushover
 * rate-limit. The first call wins; later calls are dropped. Returns a no-op
 * when `handler` is absent (the relay still logs to stderr via the watchdog).
 */
export function createPageOnce(
  handler?: (info: DialogStuckInfo) => void | Promise<void>
): (info: DialogStuckInfo) => void | Promise<void> {
  let paged = false;
  return (info: DialogStuckInfo) => {
    if (paged || !handler) return;
    paged = true;
    return handler(info);
  };
}

// Exported for tests.
export const __test__ = { buildMessage };
