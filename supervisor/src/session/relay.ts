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
export async function ensurePaneNotInMode(sessionName: string): Promise<void> {
  let mode: string;
  try {
    mode = execFileSync(
      TMUX_PATH,
      [...TMUX_ARGS, "display-message", "-t", sessionName, "-p", "#{pane_in_mode}"],
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
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "send-keys", "-t", sessionName, "-X", "cancel"], {
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

export async function tmuxSend(sessionName: string, extraArgs: string[]): Promise<void> {
  const args = [...TMUX_ARGS, "send-keys", "-t", sessionName, ...extraArgs];
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
    await ensurePaneNotInMode(sessionName);
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

  // 2. Send via tmux send-keys using execFileSync (argv array, no shell).
  // We issue the input and the submit as two separate calls:
  //   (a) `send-keys -l <literal>` — tmux forwards the bytes verbatim.
  //       Argv-based invocation avoids shell-escape hazards (backticks, $,
  //       quotes, backslashes) that corrupted long messages in earlier builds.
  //   (b) A brief delay, then `send-keys C-m` — Claude Code's ink-based TUI
  //       occasionally drops `Enter` sent in the same call when the input is
  //       long, leaving the message typed but un-submitted (issue #32).
  //
  // tmux server can transiently stall — typically right after a relay timed
  // out — so each send-keys call is wrapped in a short retry. Total budget
  // per call: 15s (tmuxSend covers transient lock waits without making the
  // overall latency unbearable).
  const literalText = fullMessage.replace(/\n/g, " ");

  try {
    // Segment (b): tmux 経路 (mode exit + Escape + send-keys -l + C-m)
    tracker.markStart("b");
    // Exit any stuck tmux mode (copy-mode, view-mode) BEFORE any send-keys.
    // A pane in copy-mode consumes keys as mode commands and silently drops
    // the payload or yields `not in a mode` on the retry path (Issue #73).
    await ensurePaneNotInMode(tmuxSessionName);
    // Clear any modal state (error dialogs, confirmation prompts) in Claude
    // Code's Ink TUI before sending input. Without this, text sent via
    // send-keys silently disappears when the TUI is in a modal state (#33).
    await tmuxSend(tmuxSessionName, ["Escape"]);
    await new Promise((r) => setTimeout(r, 50));
    await tmuxSend(tmuxSessionName, ["-l", literalText]);
    // Small pause so the TUI finishes ingesting the text before Enter.
    await new Promise((r) => setTimeout(r, 100));
    await tmuxSend(tmuxSessionName, ["C-m"]);
    tracker.markEnd("b");
  } catch (err) {
    tracker.markEnd("b");
    tracker.setError("b");
    tracker.flush();
    return {
      text: "",
      chunks: [`⚠️ Claude Code へのメッセージ送信に失敗: ${err}`],
      error: String(err),
    };
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
