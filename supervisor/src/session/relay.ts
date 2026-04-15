import { execSync, execFileSync } from "child_process";
import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { waitForRelay, type RelayResult } from "./relay-server";

const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";
const ATTACHMENT_DIR = resolve(homedir(), "claude-hub", "tmp", "attachments");

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
function tmuxSend(sessionName: string, extraArgs: string[]): void {
  const args = ["send-keys", "-t", sessionName, ...extraArgs];
  const PER_CALL_TIMEOUT = 7000;
  try {
    execFileSync(TMUX_PATH, args, { timeout: PER_CALL_TIMEOUT });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ETIMEDOUT") throw err;
    // Give tmux a breather and try one more time.
    execSync("sleep 0.25");
    execFileSync(TMUX_PATH, args, { timeout: PER_CALL_TIMEOUT });
  }
}

/**
 * Send a message to Claude Code via tmux send-keys and wait for
 * the response via HTTP relay (Stop hook POST).
 */
export async function relayMessage(
  tmuxSessionName: string,
  threadId: string,
  message: string,
  options?: { attachments?: AttachmentInfo[] }
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
      const imageInstructions = localFiles
        .map((f) => `Read the image at ${f}`)
        .join(", and ");
      fullMessage = `${imageInstructions}. ${message}`;
    }
  }

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
    tmuxSend(tmuxSessionName, ["-l", literalText]);
    // Small pause so the TUI finishes ingesting the text before Enter.
    await new Promise((r) => setTimeout(r, 100));
    tmuxSend(tmuxSessionName, ["C-m"]);
  } catch (err) {
    scheduleCleanup(localFiles, 5 * 60_000);
    return {
      text: "",
      chunks: [`⚠️ Claude Code へのメッセージ送信に失敗: ${err}`],
      error: String(err),
    };
  }

  // 3. Wait for Stop hook to POST the response
  const result = await waitForRelay(threadId, RELAY_TIMEOUT_MS);

  scheduleCleanup(localFiles, 5 * 60_000);
  return result;
}

/**
 * Schedule file cleanup after a delay.
 */
function scheduleCleanup(files: string[], delayMs: number): void {
  if (files.length === 0) return;
  setTimeout(() => {
    for (const filePath of files) {
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore
      }
    }
  }, delayMs);
}
