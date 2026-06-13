import { execFileSync } from "child_process";
import { resolve } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { waitForRelay, type RelayResult } from "./relay-server";
import { persistAttachments } from "./attachment-store";
import { TMUX_PATH, TMUX_ARGS } from "./tmux";
import { createLatencyTracker } from "./latency-logger";
import { startDialogWatchdog } from "./dialog-watchdog";
import { scheduleStallHeartbeat } from "./stall-heartbeat";
import { createPageOnce } from "./dialog-stuck-handler";
import type { DialogStuckInfo } from "./dialog-stuck-handler";
import { ATTACHMENT_DIR } from "./gc-attachments";

/** How long to wait for Claude Code Stop hook to fire (ms) */
const RELAY_TIMEOUT_MS = 5 * 60_000;

export interface AttachmentInfo {
  url: string;
  filename: string;
  contentType: string;
}

// Re-export RelayResult for consumers
export type { RelayResult } from "./relay-server";

/**
 * Download a Discord attachment to a local temp file.
 */
async function downloadAttachment(attachment: AttachmentInfo): Promise<string> {
  mkdirSync(ATTACHMENT_DIR, { recursive: true });
  const localPath = resolve(ATTACHMENT_DIR, `${Date.now()}-${attachment.filename}`);

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(localPath, buffer);
  return localPath;
}

/**
 * Run `tmux send-keys -t <sessionName> <args...>` with a short retry budget.
 *
 * tmux can ETIMEDOUT on transient server stalls (observed after a previous
 * relay hit Response timeout — the pane or server ends up briefly busy).
 * We retry once after a 250ms pause so a flaky moment doesn't surface to
 * the user as a `send-keys` failure.
 */
/** Summarize an execFileSync error without leaking message content from spawnargs. */
function summarizeExecError(err: unknown): { code?: string; status?: number; signal?: string } {
  const e = err as NodeJS.ErrnoException & { status?: number; signal?: string };
  return { code: e.code, status: e.status, signal: e.signal };
}

function getExecStderr(err: unknown): string {
  const e = err as { stderr?: Buffer | string };
  if (!e.stderr) return "";
  return typeof e.stderr === "string" ? e.stderr : e.stderr.toString();
}

/**
 * If the tmux pane is currently in copy-mode (or any other mode), exit it so
 * the subsequent `send-keys -l` reaches the application instead of being
 * consumed as a mode command. Best-effort / fail-open: any error is logged but
 * not thrown — the caller may still attempt send-keys, and a genuinely dead
 * pane will surface a clearer error from the next call.
 *
 * See Issue #73: tmux pane copy-mode stuck → send-keys silent drop + `not in a mode`.
 */
export async function ensurePaneNotInMode(
  sessionName: string,
  // Issue #199 AC1: socket selector. Defaults to the Supervisor's dedicated
  // `-L claude-hub` socket; pass `[]` to target the DEFAULT socket where the
  // claudeHubExit session lives (started by start-hijoguchi.sh with no -L).
  socketArgs: readonly string[] = TMUX_ARGS
): Promise<void> {
  let mode: string;
  try {
    mode = execFileSync(
      TMUX_PATH,
      [...socketArgs, "display-message", "-t", sessionName, "-p", "#{pane_in_mode}"],
      { timeout: 2000 }
    ).toString().trim();
  } catch (err) {
    console.warn(
      `[Relay] pane_in_mode check failed for ${sessionName}:`,
      summarizeExecError(err)
    );
    return;
  }
  if (mode !== "1") return;
  console.warn(`[Relay] pane ${sessionName} in copy-mode, cancelling before send-keys`);
  try {
    execFileSync(TMUX_PATH, [...socketArgs, "send-keys", "-t", sessionName, "-X", "cancel"], {
      timeout: 2000,
    });
  } catch (err) {
    // Pane may have exited mode between check and cancel — safe to ignore.
    console.warn(
      `[Relay] cancel after mode detection failed for ${sessionName}:`,
      summarizeExecError(err)
    );
  }
}

export async function tmuxSend(
  sessionName: string,
  extraArgs: string[],
  // Issue #199 AC1: socket selector (see ensurePaneNotInMode). Defaults to the
  // claude-hub socket; `[]` targets the default socket (claudeHubExit).
  socketArgs: readonly string[] = TMUX_ARGS
): Promise<void> {
  const args = [...socketArgs, "send-keys", "-t", sessionName, ...extraArgs];
  const PER_CALL_TIMEOUT = 7000;
  try {
    execFileSync(TMUX_PATH, args, { timeout: PER_CALL_TIMEOUT });
    return;
  } catch (err) {
    const summary = summarizeExecError(err);
    const stderr = getExecStderr(err);
    const isModeErr = /not in a mode/i.test(stderr);
    if (summary.code !== "ETIMEDOUT" && !isModeErr) {
      console.error(`[Relay] tmux send-keys failed:`, summary);
      throw err;
    }
    // Transient: tmux briefly stalled (ETIMEDOUT) OR pane was in copy-mode
    // (`not in a mode`). Exit any stuck mode and try once more.
    console.warn(
      `[Relay] tmux send-keys transient error for ${sessionName} (${isModeErr ? "not-in-a-mode" : summary.code}), recovering...`
    );
    await ensurePaneNotInMode(sessionName, socketArgs);
    await new Promise((r) => setTimeout(r, 250));
    try {
      execFileSync(TMUX_PATH, args, { timeout: PER_CALL_TIMEOUT });
    } catch (retryErr) {
      console.error(
        `[Relay] tmux send-keys retry also failed for ${sessionName}:`,
        summarizeExecError(retryErr)
      );
      throw retryErr;
    }
  }
}

/**
 * Flatten every newline (CR / LF, in any combination or run) to a single space
 * so a multi-line message survives `tmux send-keys -l`, which would otherwise
 * submit at the first newline and split/corrupt the input (Issue #210).
 *
 * The regex MUST use single-backslash `\r` / `\n` (the real CR 0x0D / LF 0x0A
 * code points). The earlier `/[\\r\\n]+/` was double-escaped and matched only
 * the literal characters `\`, `r`, `n`, so it never removed actual newlines —
 * multi-line Discord relays were silently dropped while single-line ones worked.
 */
export function flattenForSendKeys(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/**
 * Type one line into the pane and submit it, without waiting for any relay
 * response. This is the shared send sequence used by {@link relayMessage}
 * (which then waits for the Stop-hook POST) and by fire-and-forget sends such
 * as `/session compact` (Issue #200), where the TUI built-in does NOT POST a
 * Stop-hook response — waiting would just burn RELAY_TIMEOUT_MS.
 *
 * Steps (mirrors what relayMessage has always relied on):
 *   1. Exit any stuck tmux mode (copy-mode) so keys reach the app, not the
 *      mode handler (Issue #73 — silent drop / `not in a mode`).
 *   2. Escape to clear Ink TUI modal state (error/confirmation dialogs) that
 *      would otherwise swallow the input (#33).
 *   3. `send-keys -l <literal>` — argv-based, no shell, so backticks/$/quotes
 *      can't corrupt long input.
 *   4. A brief pause, then `C-m` (Enter) as a separate call — the Ink TUI can
 *      drop an Enter sent in the same call as a long literal (#32).
 *
 * Newlines are flattened to spaces because `send-keys -l` would submit at the
 * first newline.
 */
export async function sendToPane(
  tmuxSessionName: string,
  text: string,
  // Issue #199 AC1: socket selector. Defaults to the Supervisor's `-L
  // claude-hub` socket; pass `[]` to reach the claudeHubExit session on the
  // default socket. The send sequence (mode-exit/Escape/-l/C-m) is identical on
  // either socket, so this stays the single source of truth (no dead copy).
  socketArgs: readonly string[] = TMUX_ARGS
): Promise<void> {
  const literalText = flattenForSendKeys(text);
  await ensurePaneNotInMode(tmuxSessionName, socketArgs);
  await tmuxSend(tmuxSessionName, ["Escape"], socketArgs);
  await new Promise((r) => setTimeout(r, 50));
  await tmuxSend(tmuxSessionName, ["-l", literalText], socketArgs);
  await new Promise((r) => setTimeout(r, 100));
  await tmuxSend(tmuxSessionName, ["C-m"], socketArgs);
}

/**
 * Send a message to Claude Code via tmux send-keys and wait for
 * the response via HTTP relay (Stop hook POST).
 *
 * Issue #57: while waiting for the Stop-hook response, a dialog watchdog
 * polls the pane every 5s. Dialogs that slip past `--dangerously-skip-
 * permissions` (Plan mode confirmation, AskUserQuestion, MCP elicitation,
 * Bash interactive y/n) cause the TUI to stall silently — without
 * detection the relay simply times out at RELAY_TIMEOUT_MS (5 min). The
 * watchdog auto-accepts known kinds and, if the dialog persists, fires
 * `onDialogStuck` so the caller can post a heartbeat to Discord.
 */
export interface RelayMessageOptions {
  attachments?: AttachmentInfo[];
  /**
   * Project directory of the session (the claude cwd). When provided,
   * downloaded attachments are also persisted under
   * `<persistDir>/.claude/discord-materials/<threadId>/` and Claude is handed
   * the persistent path instead of the ephemeral tmp path (Issue #152). The
   * tmp copy is still cleaned up after 5 min; the persistent copy survives so
   * "material screenshots" remain readable for the whole task.
   */
  persistDir?: string;
  /**
   * Called when the relay is stuck waiting for the user. Two triggers:
   *  - the dialog watchdog exhausted its auto-accept budget for a *known*
   *    dialog family (`kind` = detected DialogKind), or
   *  - no response arrived within the stall threshold and no known dialog
   *    matched — an *unknown* dialog (`kind: "stall"`).
   * The callback typically posts a heartbeat to the Discord thread and pages
   * Pushover so the user can `tmux attach`. Errors thrown by the callback are
   * caught and logged — they never block the relay. Fired at most once per
   * relay turn.
   */
  onDialogStuck?: (info: DialogStuckInfo) => void | Promise<void>;
}

/**
 * Issue #74: user-facing notice when relaying a message to the tmux pane fails
 * outright (i.e. after the in-call retry in {@link tmuxSend}). The raw failure
 * is typically a copy-mode `not in a mode` or an ETIMEDOUT under tmux load
 * (Issue #73 / RW-019). Previously the catch path interpolated `${err}` — the
 * raw `tmux send-keys ...` command line plus the bare `not in a mode` string —
 * straight into a Discord chunk, so the thread showed bogus "responses" (the
 * #74 screenshot: `not in a mode` posted 5×). This message is deliberately
 * free of tmux internals; the raw cause is preserved in logs + `RelayResult.error`.
 */
export const SEND_FAILURE_USER_MESSAGE =
  "⚠️ メッセージを Claude Code セッションに送信できませんでした（セッションが応答不能、または画面が一時的に固まっている可能性があります）。少し待って再送するか、`/session restart` で再開してください。";

/**
 * Build the {@link RelayResult} for a send-keys failure. Pure + exported so a
 * unit test can lock that raw tmux internals never reach the user-facing chunk
 * while the diagnostic cause is still carried in `error` (Issue #74). By the
 * time this fires, {@link tmuxSend} has already retried once after exiting any
 * stuck copy-mode (Issue #73 / RW-019), so the failure is non-transient.
 */
export function buildSendFailureResult(err: unknown): RelayResult {
  return {
    text: "",
    chunks: [SEND_FAILURE_USER_MESSAGE],
    error: String(err),
  };
}

export async function relayMessage(
  tmuxSessionName: string,
  threadId: string,
  message: string,
  options?: RelayMessageOptions
): Promise<RelayResult> {
  // 1. Download attachments
  const localFiles: string[] = [];
  let fullMessage = message;

  if (options?.attachments?.length) {
    for (const att of options.attachments) {
      try {
        const localPath = await downloadAttachment(att);
        localFiles.push(localPath);
      } catch (err) {
        console.error(`[Relay] Failed to download attachment ${att.filename}:`, err);
      }
    }

    if (localFiles.length > 0) {
      // Issue #152: hand Claude the persistent project-asset paths (when a
      // persistDir is known) so the materials survive past the 5-min tmp
      // cleanup. Falls back to the tmp paths per-file if persistence fails.
      const claudeFiles = options.persistDir
        ? await persistAttachments(localFiles, options.persistDir, threadId)
        : localFiles;
      const imageInstructions = claudeFiles
        .map((f) => `Read the image at ${f}`)
        .join(", and ");
      fullMessage = `${imageInstructions}. ${message}`;
    }
  }

  // Latency tracker: Issue #135 / Epic #101 で高負荷時 70s+ 遅延の dominant
  // segment を特定するために各 segment の所要 ms を記録。session_id には
  // tmux session 名 (= supervisor 内で安定識別子) を使う。
  // 観測機構の失敗は relay 本来の処理を止めない (latency-logger.ts 参照)。
  const tracker = createLatencyTracker(tmuxSessionName);

  // 2. Send via tmux send-keys (mode exit + Escape + send-keys -l + C-m). The
  // full sequence and its rationale (Issue #73 copy-mode, #33 modal clear, #32
  // dropped Enter, argv-no-shell safety) live in sendToPane, shared with the
  // fire-and-forget compact path (Issue #200).
  try {
    // Segment (b): tmux 経路
    tracker.markStart("b");
    await sendToPane(tmuxSessionName, fullMessage);
    tracker.markEnd("b");
  } catch (err) {
    tracker.markEnd("b");
    tracker.setError("b");
    tracker.flush();
    // Issue #74: keep the raw tmux cause in logs + `RelayResult.error`, but
    // NEVER forward it into the Discord chunk (it would surface as a bogus
    // `not in a mode` "response"). buildSendFailureResult returns a clean,
    // actionable notice instead.
    console.error(
      `[Relay] sendToPane failed for ${tmuxSessionName}:`,
      summarizeExecError(err)
    );
    return buildSendFailureResult(err);
  }

  // Segment (c): tmux send 完了 → waitForRelay 開始までの隙間 (大体ゼロ、
  // でも明示的に記録しておくことで設計レビュー時の sanity check になる)
  tracker.markStart("c");
  tracker.markEnd("c");

  // 3. Wait for Stop hook to POST the response
  // Segment (d_e_c): claude TUI 受信 + skill/hook init + MCP capability
  // discovery + Anthropic API 呼出 + Stop hook fire の合計。supervisor から
  // は内訳を分離できないため 1 まとめで記録 (Issue #135 で「(d)+(e)+(c)」と
  // して観測する設計と一致)。
  tracker.markStart("d_e_c");

  // Issue #12: page the user at most once per relay turn. Two independent
  // triggers can fire — the watchdog (known dialog, ~10s) and the stall timer
  // (unknown dialog, 3min). For a persistent *known* dialog both would
  // otherwise fire, double-posting to Discord and risking a Pushover
  // rate-limit. `createPageOnce` collapses them to a single page; the first
  // trigger wins (the watchdog reports the precise dialog kind when it can).
  const pageOnce = createPageOnce(options?.onDialogStuck);

  // Issue #57: Start the dialog watchdog *during* the wait. Stops in
  // finally so a thrown error or early return path can never leak the
  // timer handle. The watchdog's DialogMatch is adapted to DialogStuckInfo
  // (adding tmuxSessionName so the heartbeat can tell the user which session
  // to `tmux attach`). If the caller supplied no onDialogStuck we still log
  // to stderr inside the watchdog so the dialog surfaces in supervisor logs.
  const watchdog = startDialogWatchdog({
    tmuxSessionName,
    onHeartbeat: options?.onDialogStuck
      ? (match) =>
          pageOnce({
            kind: match.kind,
            line: match.line,
            tmuxSessionName,
          })
      : undefined,
  });

  // Issue #12 (Journey AC #2): the watchdog only fires for *known* dialog
  // families. An unknown dialog leaves the relay waiting silently. This
  // one-shot stall timer is the final defense — it pages the user once if no
  // response arrives within the stall threshold, then the relay keeps waiting
  // up to RELAY_TIMEOUT_MS. Cancelled in finally as soon as we resolve.
  const stall = scheduleStallHeartbeat({
    fire: () => {
      // Always surface the stall in supervisor logs: when no onDialogStuck
      // handler is registered pageOnce is a silent no-op, so without this the
      // 3-min stall would never appear anywhere observable (gemini #195).
      console.warn(
        `[Relay] session ${tmuxSessionName} stalled: no response within stall threshold`
      );
      return pageOnce({
        kind: "stall",
        line: "no response within stall threshold",
        tmuxSessionName,
      });
    },
  });

  let result: RelayResult;
  try {
    result = await waitForRelay(threadId, RELAY_TIMEOUT_MS);
  } finally {
    watchdog.stop();
    stall.cancel();
  }
  tracker.markEnd("d_e_c");
  if (result.error) {
    tracker.setError("d_e_c");
  }
  tracker.flush();

  // Note: downloaded attachments are intentionally NOT deleted here. They used
  // to be unlinked 5 minutes after each relay, which made material screenshots
  // vanish between sessions (Issue #151). They now persist in ATTACHMENT_DIR and
  // are swept only by age via gc-attachments (com.claude-hub.gc-attachments,
  // daily, 30-day retention).
  return result;
}
