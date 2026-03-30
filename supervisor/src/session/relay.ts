import { execSync } from "child_process";
import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { waitForRelay } from "./relay-server";

const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";
const ATTACHMENT_DIR = resolve(homedir(), "claude-hub", "tmp", "attachments");

/** How long to wait for Claude Code Stop hook to fire (ms) */
const RELAY_TIMEOUT_MS = 5 * 60_000;

export interface AttachmentInfo {
  url: string;
  filename: string;
  contentType: string;
}

// Re-export RelayResult from relay-server for consumers
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
 * Send a message to Claude Code via tmux send-keys and wait for
 * the response via HTTP relay (Stop hook POST).
 */
export async function relayMessage(
  tmuxSessionName: string,
  threadId: string,
  message: string,
  options?: { attachments?: AttachmentInfo[] }
): Promise<import("./relay-server").RelayResult> {
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

  // 2. Escape and send via tmux send-keys
  const escaped = fullMessage
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");

  try {
    execSync(
      `${TMUX_PATH} send-keys -t "${tmuxSessionName}" "${escaped}" Enter`,
      { timeout: 5000 }
    );
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
