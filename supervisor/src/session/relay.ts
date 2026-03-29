import { execSync } from "child_process";
import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { formatForDiscord } from "./output-formatter";

const TMUX_PATH = "/opt/homebrew/bin/tmux";
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
function isAtPrompt(content: string): boolean {
  const lines = content.trim().split("\n");
  // Check last few non-empty lines for the prompt
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i]?.trim() ?? "";
    if (line === "❯" || line.startsWith("❯ ")) {
      if (line === "❯") return true;
    }
  }
  return false;
}

/**
 * Extract Claude Code's response from capture-pane output.
 * Looks for content between our input and the next prompt.
 */
function extractResponse(
  beforeContent: string,
  afterContent: string,
  inputMessage: string
): string {
  // Find new content that appeared after sending the message
  const beforeLines = beforeContent.split("\n");
  const afterLines = afterContent.split("\n");

  // Find where our input appears in the after content
  let inputLineIdx = -1;
  const inputFirstLine = inputMessage.slice(0, 60); // First part of our message
  for (let i = 0; i < afterLines.length; i++) {
    if (afterLines[i]?.includes(inputFirstLine)) {
      inputLineIdx = i;
      break;
    }
  }

  if (inputLineIdx === -1) {
    // Couldn't find our input, try to extract everything new
    return extractNewContent(beforeLines, afterLines);
  }

  // Extract content between our input and the next prompt
  const responseLines: string[] = [];
  let foundResponse = false;
  for (let i = inputLineIdx + 1; i < afterLines.length; i++) {
    const line = afterLines[i] ?? "";
    const trimmed = line.trim();

    // Skip the horizontal rule separators
    if (trimmed.match(/^[─━]{10,}$/)) {
      if (foundResponse) break; // End of response section
      continue;
    }

    // Stop at the next prompt
    if (trimmed === "❯") break;

    // Skip empty lines at the start
    if (!foundResponse && trimmed === "") continue;

    // Skip lines that are part of the status bar
    if (trimmed.includes("bypass permissions") || trimmed.includes("ctx")) continue;
    if (trimmed.includes("⏵⏵")) continue;

    // Skip the "Read N file" tool usage indicator
    if (trimmed.match(/^Read \d+ files?/)) continue;

    // Collect response content
    // Remove the "⏺ " prefix that Claude Code adds
    const cleaned = line.replace(/^\s*⏺\s?/, "").replace(/^\s*⎿\s*/, "  ");
    if (cleaned.trim() || foundResponse) {
      foundResponse = true;
      responseLines.push(cleaned);
    }
  }

  return responseLines.join("\n").trim();
}

function extractNewContent(beforeLines: string[], afterLines: string[]): string {
  // Simple diff: find lines in after that weren't in before
  const beforeSet = new Set(beforeLines.map((l) => l.trim()));
  const newLines = afterLines.filter((l) => !beforeSet.has(l.trim()) && l.trim());
  return newLines.join("\n").trim();
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
        cleanupFiles(localFiles);
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
      cleanupFiles(localFiles);

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
      cleanupFiles(localFiles);
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

function cleanupFiles(files: string[]): void {
  for (const filePath of files) {
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
