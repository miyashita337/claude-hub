const DISCORD_MAX_LENGTH = 2000;
const CODE_FENCE = "```";
// Leave room for closing code fence if we need to split inside one
const SAFE_LIMIT = DISCORD_MAX_LENGTH - 20;

/**
 * Split Claude Code output into Discord-safe message chunks.
 * Respects code block boundaries (``` ... ```) and avoids splitting inside them.
 */
export function formatForDiscord(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = findSplitPoint(remaining, SAFE_LIMIT);
    const chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // If we're splitting inside a code block, close it and reopen in next chunk
    const openFences = countOpenFences(chunk);
    if (openFences % 2 === 1) {
      // Find the language specifier from the last opening fence
      const lang = getLastFenceLanguage(chunk);
      chunks.push(chunk + "\n" + CODE_FENCE);
      remaining = CODE_FENCE + lang + "\n" + remaining;
    } else {
      chunks.push(chunk);
    }
  }

  return chunks;
}

/**
 * Find the best place to split text, preferring line boundaries.
 */
function findSplitPoint(text: string, maxLen: number): number {
  // Try to split at a newline before maxLen
  const lastNewline = text.lastIndexOf("\n", maxLen);
  if (lastNewline > maxLen * 0.5) {
    return lastNewline + 1; // Include the newline in current chunk
  }

  // Try to split at a space
  const lastSpace = text.lastIndexOf(" ", maxLen);
  if (lastSpace > maxLen * 0.5) {
    return lastSpace + 1;
  }

  // Hard split at maxLen
  return maxLen;
}

/**
 * Count unmatched code fences (```) in a string.
 */
function countOpenFences(text: string): number {
  let count = 0;
  let idx = 0;
  while (idx < text.length) {
    const fenceStart = text.indexOf(CODE_FENCE, idx);
    if (fenceStart === -1) break;
    count++;
    idx = fenceStart + CODE_FENCE.length;
    // Skip past language specifier on opening fences
    if (count % 2 === 1) {
      const lineEnd = text.indexOf("\n", idx);
      if (lineEnd !== -1) {
        idx = lineEnd + 1;
      }
    }
  }
  return count;
}

/**
 * Get the language specifier from the last opening code fence.
 */
function getLastFenceLanguage(text: string): string {
  let lastLang = "";
  let idx = 0;
  let count = 0;
  while (idx < text.length) {
    const fenceStart = text.indexOf(CODE_FENCE, idx);
    if (fenceStart === -1) break;
    count++;
    idx = fenceStart + CODE_FENCE.length;
    if (count % 2 === 1) {
      // Opening fence — grab language
      const lineEnd = text.indexOf("\n", idx);
      if (lineEnd !== -1) {
        lastLang = text.slice(idx, lineEnd).trim();
        idx = lineEnd + 1;
      }
    }
  }
  return lastLang ? lastLang : "";
}

/**
 * Parse Claude Code stream-json output and extract the final text result.
 */
export function parseStreamJsonOutput(rawOutput: string): string {
  const lines = rawOutput.trim().split("\n");

  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);

      // Look for the result message
      if (parsed.type === "result" && parsed.result) {
        return parsed.result;
      }

      // Look for assistant message with text content
      if (parsed.type === "assistant" && parsed.message?.content) {
        const textBlocks = parsed.message.content.filter(
          (block: { type: string }) => block.type === "text"
        );
        if (textBlocks.length > 0) {
          return textBlocks.map((b: { text: string }) => b.text).join("\n");
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return "";
}
