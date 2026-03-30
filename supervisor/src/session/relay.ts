import { execSync } from "child_process";
import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { formatForDiscord } from "./output-formatter";

const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";
const ATTACHMENT_DIR = resolve(homedir(), "claude-hub", "tmp", "attachments");

/** How long to wait for Claude Code to start responding (ms) */
const RESPONSE_START_TIMEOUT_MS = 60_000;
/** How long to wait for Claude Code to finish responding (ms) */
const RESPONSE_COMPLETE_TIMEOUT_MS = 5 * 60_000;
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
 *
 * Scans the last 8 lines for:
 * - "❯" alone = at prompt (ready)
 * - Thinking indicators (✱ ✶ ✻ ✢ ✳ + Running…) = still processing
 */
export function isAtPrompt(content: string): boolean {
  const lines = content.trim().split("\n");

  // Find "❯" near the end — must be surrounded by separator lines (────)
  // to distinguish from mid-response prompts
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const line = lines[i]?.trim() ?? "";

    // Thinking/processing indicators = still working
    if (
      line.startsWith("✱") || line.startsWith("✶") || line.startsWith("✻") ||
      line.startsWith("✢") || line.startsWith("✳") || line.startsWith("+") ||
      line.includes("Running…") || line.includes("thinking")
    ) {
      return false;
    }

    // Permission dialog indicators = still waiting for user input
    if (line.startsWith("❯ 1.") || line.startsWith("❯ 2.") || line.startsWith("❯ 3.")) {
      return false;
    }
    if (line.includes("Do you want to") || line.includes("Esc to cancel")) {
      return false;
    }

    // Empty prompt with separator above = Claude Code is ready
    if (line === "❯") {
      // Verify separator line exists nearby (within 2 lines above)
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        const aboveLine = lines[j]?.trim() ?? "";
        if (aboveLine.match(/^[─━]{10,}$/)) return true;
      }
      // Also accept if ❯ is on the last non-empty line (fallback)
      const remaining = lines.slice(i + 1).filter(l => l.trim());
      if (remaining.length <= 2) return true;
    }
  }
  return false;
}

/**
 * Extract Claude Code's response from capture-pane output.
 *
 * Strategy: Find the LAST ⏺ block that contains actual text response
 * (not tool invocations like ⏺ Bash(...) or ⏺ Read(...)).
 * Also collects tool result summaries from ⎿ lines.
 */
export function extractResponse(
  _beforeContent: string,
  afterContent: string,
  inputMessage: string
): string {
  const afterLines = afterContent.split("\n");

  // Find where our input appears — search for first 30 chars of the message
  // (relay may prepend "Read the image at..." so we also try the original)
  let inputLineIdx = -1;
  const searchTerms = [
    inputMessage.slice(0, 40),
    inputMessage.slice(0, 20),
  ];

  for (const term of searchTerms) {
    if (!term) continue;
    for (let i = 0; i < afterLines.length; i++) {
      if (afterLines[i]?.includes(term)) {
        inputLineIdx = i;
        break;
      }
    }
    if (inputLineIdx !== -1) break;
  }

  if (inputLineIdx === -1) return "";

  // Collect ALL ⏺ blocks after our input, then return the last "text" block
  const blocks: { type: "text" | "tool"; content: string }[] = [];
  let currentBlock: string[] = [];
  let currentType: "text" | "tool" = "text";
  let inBlock = false;

  for (let i = inputLineIdx + 1; i < afterLines.length; i++) {
    const line = afterLines[i] ?? "";
    const trimmed = line.trim();

    // Stop at final prompt
    if (trimmed === "❯") {
      if (inBlock && currentBlock.length > 0) {
        blocks.push({ type: currentType, content: currentBlock.join("\n").trim() });
      }
      break;
    }

    // Stop at separator (────) only if we have content
    if (trimmed.match(/^[─━]{10,}$/)) {
      if (inBlock && currentBlock.length > 0) {
        blocks.push({ type: currentType, content: currentBlock.join("\n").trim() });
        currentBlock = [];
        inBlock = false;
      }
      continue;
    }

    // Skip noise
    if (trimmed.includes("⏵⏵") || trimmed.includes("bypass permissions")) continue;
    if (trimmed.match(/^\S.*\|.*ctx/)) continue;
    if (trimmed.match(/^Read \d+ files?\s/)) continue;
    if (trimmed.includes("ctrl+o to expand")) continue;
    if (trimmed.includes("ctrl+b ctrl+b")) continue;
    if (trimmed.startsWith("✱") || trimmed.startsWith("✶") ||
        trimmed.startsWith("✻") || trimmed.startsWith("✢") ||
        trimmed.startsWith("✳")) continue;

    // New ⏺ block
    if (trimmed.startsWith("⏺")) {
      // Save previous block
      if (inBlock && currentBlock.length > 0) {
        blocks.push({ type: currentType, content: currentBlock.join("\n").trim() });
      }

      const text = line.replace(/^\s*⏺\s?/, "");
      // Detect tool invocations: ⏺ Bash(...), ⏺ Read(...), ⏺ Write(...), etc.
      const isToolCall = /^(Bash|Read|Write|Edit|Glob|Grep|Agent|Skill)\(/.test(text.trim());
      currentType = isToolCall ? "tool" : "text";
      currentBlock = [text];
      inBlock = true;
      continue;
    }

    // Continuation lines
    if (inBlock) {
      const cleaned = line.replace(/^\s*⎿\s*/, "  ");
      currentBlock.push(cleaned);
    }
  }

  // Find the last text block (the actual response to the user)
  const textBlocks = blocks.filter((b) => b.type === "text");
  if (textBlocks.length > 0) {
    return textBlocks[textBlocks.length - 1]!.content;
  }

  // Fallback: if only tool blocks, summarize them
  if (blocks.length > 0) {
    return blocks.map((b) => b.content).join("\n\n");
  }

  return "";
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

  // Capture pane BEFORE sending
  const beforeContent = capturePaneContent(tmuxSessionName);

  // Check if Claude Code is at prompt
  if (!isAtPrompt(beforeContent)) {
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

  // Escape special characters for tmux send-keys
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

    // Check if response has started (content changed)
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

    // Response started — wait for completion (back at prompt)
    if (isAtPrompt(currentContent)) {
      // Use the ORIGINAL message for search (before image path prepend)
      const responseText = extractResponse(beforeContent, currentContent, message);
      scheduleCleanup(localFiles, 5 * 60_000);

      if (!responseText) {
        // Fallback: try with the full message (including image paths)
        const fallbackText = extractResponse(beforeContent, currentContent, fullMessage);
        if (fallbackText) {
          return {
            text: fallbackText,
            chunks: formatForDiscord(fallbackText),
          };
        }
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
