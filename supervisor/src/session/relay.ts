import { execSync } from "child_process";
import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { formatForDiscord } from "./output-formatter";

const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";
const ATTACHMENT_DIR = resolve(homedir(), "claude-hub", "tmp", "attachments");

/** How long to wait for Claude Code to start responding (ms) */
const RESPONSE_START_TIMEOUT_MS = 60_000; // 1 minute
/** How long to wait for Claude Code to finish responding after it starts (ms) */
const RESPONSE_COMPLETE_TIMEOUT_MS = 5 * 60_000; // 5 minutes
/** Polling interval for capture-pane (ms) */
const POLL_INTERVAL_MS = 2_000;

export interface AttachmentInfo {
  url: string;
  filename: string;
  contentType: string;
}

export interface RelayResult {
  text: string;
  chunks: string[];
  error?: string;
}

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
 * Capture the current tmux pane content.
 */
function capturePaneContent(tmuxSessionName: string): string {
  try {
    return execSync(
      `${TMUX_PATH} capture-pane -t "${tmuxSessionName}" -p -S -200`,
      { encoding: "utf8", timeout: 5000 }
    );
  } catch {
    return "";
  }
}

/**
 * Check if Claude Code is at the prompt (ready for input).
 * Detects the "❯" prompt character at the start of a line.
 */
export function isAtPrompt(content: string): boolean {
  const lines = content.trim().split("\n");
  // Check if Claude Code is at an empty prompt (ready for input)
  // The prompt "❯" must appear near the end, between separator lines (────)
  // and there must NOT be any thinking/processing indicators after the last ⏺ response
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const line = lines[i]?.trim() ?? "";
    // Thinking/processing indicators mean Claude Code is still working
    if (line.startsWith("✱") || line.startsWith("✶") || line.startsWith("✻") ||
        line.startsWith("✢") || line.startsWith("✳") || line.startsWith("+") ||
        line.includes("Running…") || line.includes("thinking")) {
      return false;
    }
    // Empty prompt — Claude Code is ready for input
    if (line === "❯") return true;
  }
  return false;
}

/**
 * Extract Claude Code's response from capture-pane output.
 *
 * tmux capture-pane output format:
 * ```
 * ❯ <user input>
 *
 *   Read N file(s) (ctrl+o to expand)     ← optional tool use
 *
 * ⏺ <response text>                       ← main response (may span multiple lines)
 *   <continuation>
 *
 * ─────────────────────                    ← separator
 * ❯                                        ← next prompt (empty = ready)
 * ─────────────────────                    ← separator
 *   status bar...                          ← status info
 * ```
 */
export function extractResponse(
  _beforeContent: string,
  afterContent: string,
  inputMessage: string
): string {
  const afterLines = afterContent.split("\n");

  // Find where our input appears
  let inputLineIdx = -1;
  const inputFirstWords = inputMessage.slice(0, 50);
  for (let i = 0; i < afterLines.length; i++) {
    if (afterLines[i]?.includes(inputFirstWords)) {
      inputLineIdx = i;
      break;
    }
  }

  if (inputLineIdx === -1) return "";

  // Find the response block: lines starting with ⏺ or indented continuation
  const responseLines: string[] = [];
  let inResponse = false;

  for (let i = inputLineIdx + 1; i < afterLines.length; i++) {
    const line = afterLines[i] ?? "";
    const trimmed = line.trim();

    // Stop at separator line followed by empty prompt
    if (trimmed.match(/^[─━]{10,}$/)) {
      if (inResponse) break;
      continue;
    }

    // Stop at empty prompt
    if (trimmed === "❯") break;

    // Skip status bar lines
    if (trimmed.includes("⏵⏵") || trimmed.includes("bypass permissions")) continue;
    if (trimmed.match(/^\S.*\|.*ctx/)) continue;

    // Skip tool use indicators
    if (trimmed.match(/^Read \d+ files?/)) continue;
    if (trimmed.includes("ctrl+o to expand")) continue;

    // Skip thinking/choreography indicators (✱)
    if (trimmed.startsWith("✱")) continue;

    // Detect response start (⏺ prefix)
    if (trimmed.startsWith("⏺")) {
      inResponse = true;
      const text = line.replace(/^\s*⏺\s?/, "");
      responseLines.push(text);
      continue;
    }

    // Continuation lines (indented text after ⏺)
    if (inResponse) {
      // Tool result lines (⎿ prefix)
      const cleaned = line.replace(/^\s*⎿\s*/, "  ");
      if (cleaned.trim() || responseLines.length > 0) {
        responseLines.push(cleaned);
      }
    }
  }

  return responseLines.join("\n").trim();
}

/**
 * Send a message to Claude Code via tmux send-keys and capture the response.
 */
export async function relayMessage(
  tmuxSessionName: string,
  message: string,
  attachments?: AttachmentInfo[]
): Promise<RelayResult> {
  // Download attachments and build the message
  const localFiles: string[] = [];
  let fullMessage = message;

  if (attachments?.length) {
    for (const att of attachments) {
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

  // Capture the pane content BEFORE sending
  const beforeContent = capturePaneContent(tmuxSessionName);

  // Check if Claude Code is at prompt
  if (!isAtPrompt(beforeContent)) {
    // Claude Code might be busy. Wait a bit and check again.
    await new Promise((r) => setTimeout(r, 3000));
    const retryContent = capturePaneContent(tmuxSessionName);
    if (!isAtPrompt(retryContent)) {
      return {
        text: "",
        chunks: ["⚠️ Claude Code は現在処理中です。しばらく待ってから再度お試しください。"],
        error: "Claude Code is busy",
      };
    }
  }

  // Send the message via tmux send-keys
  // Escape special characters for tmux
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
    return {
      text: "",
      chunks: [`⚠️ Claude Code へのメッセージ送信に失敗: ${err}`],
      error: String(err),
    };
  }

  // Poll for response
  let responseStarted = false;
  const startTime = Date.now();

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const currentContent = capturePaneContent(tmuxSessionName);
    const elapsed = Date.now() - startTime;

    // Check if response has started (content changed from before)
    if (!responseStarted) {
      if (currentContent !== beforeContent) {
        responseStarted = true;
      } else if (elapsed > RESPONSE_START_TIMEOUT_MS) {
        scheduleCleanup(localFiles, 5 * 60_000);
        return {
          text: "",
          chunks: ["⚠️ Claude Code からの応答がタイムアウトしました（開始待ち）。"],
          error: "Response start timeout",
        };
      }
      continue;
    }

    // Response has started — wait for it to complete (back at prompt)
    if (isAtPrompt(currentContent)) {
      const responseText = extractResponse(beforeContent, currentContent, message);
      // Don't clean up files immediately — Claude Code may still be reading them
      // Schedule cleanup after 5 minutes
      scheduleCleanup(localFiles, 5 * 60_000);

      if (!responseText) {
        return {
          text: "",
          chunks: ["（応答なし）"],
        };
      }

      return {
        text: responseText,
        chunks: formatForDiscord(responseText),
      };
    }

    if (elapsed > RESPONSE_COMPLETE_TIMEOUT_MS) {
      // Try to extract partial response
      const partialText = extractResponse(beforeContent, currentContent, message);
      scheduleCleanup(localFiles, 5 * 60_000);
      return {
        text: partialText,
        chunks: formatForDiscord(
          partialText
            ? `${partialText}\n\n⚠️ （応答がタイムアウトしました。上記は途中までの結果です）`
            : "⚠️ Claude Code からの応答がタイムアウトしました。"
        ),
        error: "Response complete timeout",
      };
    }
  }
}

/**
 * Schedule file cleanup after a delay.
 * Claude Code needs time to Read the files via its tool,
 * so we can't delete them immediately after the response.
 */
function scheduleCleanup(files: string[], delayMs: number): void {
  if (files.length === 0) return;
  setTimeout(() => {
    for (const filePath of files) {
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }, delayMs);
}
