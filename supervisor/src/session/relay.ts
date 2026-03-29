import { spawn } from "child_process";
import { resolve } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { formatForDiscord, parseStreamJsonOutput } from "./output-formatter";
import { updateSessionClaudeId } from "../infra/db";

const CLAUDE_PATH = resolve(homedir(), ".local", "bin", "claude");
const ATTACHMENT_DIR = resolve(homedir(), "claude-hub", "tmp", "attachments");
const RELAY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per message

export interface RelayOptions {
  sessionId: string;
  projectDir: string;
  claudeSessionId?: string;
  message: string;
  attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
  url: string;
  filename: string;
  contentType: string;
}

export interface RelayResult {
  text: string;
  chunks: string[];
  claudeSessionId?: string;
  error?: string;
}

/**
 * Download a Discord attachment to a local temp file.
 * Returns the local file path.
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
 * Run claude -p with the given message and return the result.
 */
export async function relayMessage(options: RelayOptions): Promise<RelayResult> {
  const { sessionId, projectDir, claudeSessionId, message, attachments } = options;

  // Download attachments to local files
  const localFiles: string[] = [];
  if (attachments?.length) {
    for (const att of attachments) {
      try {
        const localPath = await downloadAttachment(att);
        localFiles.push(localPath);
      } catch (err) {
        console.error(`[Relay] Failed to download attachment ${att.filename}:`, err);
      }
    }
  }

  // Build claude -p arguments
  const args: string[] = [
    "-p",
    message,
    "--output-format", "json",
    "--dangerously-skip-permissions",
  ];

  // Add --resume if we have a previous session ID
  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }

  // Add file arguments for attachments
  for (const filePath of localFiles) {
    args.push("--file", filePath);
  }

  return new Promise<RelayResult>((resolvePromise) => {
    const proc = spawn(CLAUDE_PATH, args, {
      cwd: projectDir,
      env: {
        ...process.env,
        PATH: `${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Timeout watchdog
    const timeout = setTimeout(() => {
      console.error(`[Relay] Timeout after ${RELAY_TIMEOUT_MS / 1000}s, killing process`);
      proc.kill("SIGKILL");
    }, RELAY_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);

      // Clean up downloaded attachments
      for (const filePath of localFiles) {
        try {
          unlinkSync(filePath);
        } catch {
          // Ignore cleanup errors
        }
      }

      if (code !== 0 && !stdout) {
        const errorMsg = stderr || `claude -p exited with code ${code}`;
        console.error(`[Relay] Error: ${errorMsg}`);
        resolvePromise({
          text: "",
          chunks: [`⚠️ Claude Code エラー:\n\`\`\`\n${errorMsg.slice(0, 1500)}\n\`\`\``],
          error: errorMsg,
        });
        return;
      }

      // Parse the JSON output
      let resultText = "";
      let newClaudeSessionId: string | undefined;

      try {
        const parsed = JSON.parse(stdout);
        resultText = parsed.result || "";
        newClaudeSessionId = parsed.session_id;
      } catch {
        // Fallback: try stream-json parsing
        resultText = parseStreamJsonOutput(stdout);
      }

      // Save claude_session_id for future --resume
      if (newClaudeSessionId) {
        try {
          updateSessionClaudeId(sessionId, newClaudeSessionId);
        } catch (err) {
          console.error("[Relay] Failed to save claude session ID:", err);
        }
      }

      if (!resultText) {
        resolvePromise({
          text: "",
          chunks: ["（応答なし）"],
          claudeSessionId: newClaudeSessionId,
        });
        return;
      }

      const chunks = formatForDiscord(resultText);
      resolvePromise({
        text: resultText,
        chunks,
        claudeSessionId: newClaudeSessionId,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      console.error("[Relay] Process error:", err);
      resolvePromise({
        text: "",
        chunks: [`⚠️ Claude Code 起動エラー: ${err.message}`],
        error: err.message,
      });
    });

    // Close stdin immediately (we pass message via args)
    proc.stdin.end();
  });
}
