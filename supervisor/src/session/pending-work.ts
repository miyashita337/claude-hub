/**
 * Pending-work detection for headless dispatch runs (Issue #342).
 *
 * A headless worker (`claude -p`) dies at turn end. Anything it left in
 * flight — a `run_in_background` Bash/Agent task, a foreground Bash that hit
 * its timeout and was auto-moved to the background, or a `ScheduleWakeup`
 * reservation — is silently lost: the child exits 0, no PR exists, and the
 * dispatch report looks like a success (observed live twice: #338 and
 * agent-base#456; see the Issue for the transcripts).
 *
 * This module is the SHARED pure core for both defence layers:
 *   - Layer 1 (prevention): `hooks/headless-pending-guard.ts`, a Stop hook
 *     injected via `--settings` into headless children, blocks the turn end
 *     while pending work remains (empirically verified: Stop hooks fire and
 *     `decision:block` forces continuation under `claude -p`, v2.x).
 *   - Layer 2 (detection): `manager.runHeadless` parses the transcript after
 *     the child exits and surfaces `pending` / `unknown` in the dispatch
 *     report instead of tearing the worktree down as if the run were clean.
 *
 * Detection uses ONLY deterministic signals (AgentTeams review, #342):
 * structural JSONL fields and CLI-emitted literals pinned by fixture tests.
 * Free-text matching of the model's own prose ("I'll continue when it
 * finishes") is deliberately NOT used — that would be the RW-027/RW-047
 * string-match anti-pattern applied to model output.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** One background task that was started but never reported back. */
export interface PendingTask {
  /** The Bash/Agent `tool_use` id that started the task. */
  toolUseId: string;
  /** The harness task id, when the start carried one (timeout-backgrounded). */
  taskId?: string;
  /**
   * How the task went to the background:
   *   - `run_in_background`: the tool call asked for it explicitly.
   *   - `timeout_backgrounded`: a foreground Bash exceeded its timeout and the
   *     harness moved it to the background (tool_result literal, see below).
   */
  source: "run_in_background" | "timeout_backgrounded";
}

/** Deterministic pending-work summary parsed from a session transcript. */
export interface PendingWork {
  /** Background tasks with no matching `<task-notification>` afterwards. */
  pendingTasks: PendingTask[];
  /**
   * True when a non-stop `ScheduleWakeup` was called and neither a later
   * `stop: true` call nor a later injected user prompt (= the wakeup firing)
   * appears in the transcript. In a headless run such a reservation can never
   * fire — the process exits at turn end.
   */
  pendingWakeup: boolean;
  /** Lines that failed to parse as JSON (diagnostic; >0 weakens confidence). */
  skippedLines: number;
}

export type PendingWorkProbe =
  | { ok: true; value: PendingWork }
  | { ok: false; error: string };

/**
 * CLI-emitted literal for a foreground command that was auto-moved to the
 * background on timeout. Pinned against a real v2.x transcript
 * (agent-base#456, tool_result of `toolu_01EKmsva…`):
 *
 *   "Command did not complete within its 600s timeout and was moved to the
 *    background (ID: bas5ws1zh). Output is being written to: …"
 *
 * This is harness output, not model prose. If a CLI update rewords it the
 * match degrades to a false negative — which Layer 2's process-group probe
 * (manager.ts) still catches, and the fixture test documents the contract.
 */
const TIMEOUT_BACKGROUNDED_RE = /moved to the background \(ID: ([A-Za-z0-9_-]+)\)/;

/** `<tool-use-id>` values inside a `<task-notification>` completion block. */
const NOTIFICATION_TOOL_USE_ID_RE = /<tool-use-id>([^<]+)<\/tool-use-id>/g;

/**
 * Derive the transcript path Claude Code writes for a session: the cwd with
 * every non-alphanumeric character folded to `-`, under `~/.claude/projects`.
 * Verified against real dirs (e.g. `/Users/x/agent-base/.claude/worktrees/
 * corp-dispatch-456` → `-Users-x-agent-base--claude-worktrees-corp-dispatch-456`).
 */
export function deriveTranscriptPath(
  cwd: string,
  claudeSessionId: string,
  home: string = homedir(),
): string {
  const key = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return join(home, ".claude", "projects", key, `${claudeSessionId}.jsonl`);
}

/** Extract the plain-text pieces of a tool_result `content` (string or array). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: string }).type === "text"
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * True when a `user`-typed entry is an actual injected prompt (the initial
 * `-p` command, or a fired ScheduleWakeup) rather than a tool_result carrier
 * or a `<task-notification>` injection. Used to decide whether a scheduled
 * wakeup ever fired: firing is the only way a headless run gets a new plain
 * user prompt mid-session.
 */
function isPlainUserPrompt(entry: Record<string, unknown>): boolean {
  if (entry.type !== "user") return false;
  const message = entry.message;
  if (!message || typeof message !== "object") return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return !content.includes("<task-notification>");
  }
  if (Array.isArray(content)) {
    const hasToolResult = content.some(
      (c) => c && typeof c === "object" && (c as { type?: string }).type === "tool_result",
    );
    if (hasToolResult) return false;
    const text = content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: string }).type === "text"
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
    return text.length > 0 && !text.includes("<task-notification>");
  }
  return false;
}

/**
 * Parse a session transcript (JSONL text) into its pending-work summary.
 * Pure and synchronous so both the Stop hook and the manager probe share it
 * and unit tests can pin the contract with fixture lines.
 */
export function parsePendingWork(jsonlText: string): PendingWork {
  const starts = new Map<string, PendingTask>();
  const completedToolUseIds = new Set<string>();
  let skippedLines = 0;

  // Wakeup bookkeeping: index of the last un-consumed non-stop ScheduleWakeup,
  // and the index of the last plain user prompt (a fired wakeup appears as one).
  let lastWakeupIdx = -1;
  let lastPlainUserIdx = -1;

  const lines = jsonlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;

    // Completion notifications carry the XML literally inside the JSON string,
    // in both `queue-operation` entries and injected user messages — a raw-line
    // scan covers every container shape without depending on any of them.
    if (line.includes("<task-notification>")) {
      for (const m of line.matchAll(NOTIFICATION_TOOL_USE_ID_RE)) {
        completedToolUseIds.add(m[1]!);
      }
    }

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skippedLines++;
      continue;
    }

    if (isPlainUserPrompt(entry)) {
      lastPlainUserIdx = i;
    }

    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const c = item as {
        type?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: unknown;
      };

      if (c.type === "tool_use" && typeof c.id === "string") {
        const input =
          c.input && typeof c.input === "object"
            ? (c.input as Record<string, unknown>)
            : undefined;
        if (input?.run_in_background === true) {
          starts.set(c.id, { toolUseId: c.id, source: "run_in_background" });
        }
        if (c.name === "ScheduleWakeup") {
          if (input?.stop === true) {
            lastWakeupIdx = -1; // reservation explicitly cancelled
          } else {
            lastWakeupIdx = i;
          }
        }
      }

      if (c.type === "tool_result" && typeof c.tool_use_id === "string") {
        const text = toolResultText(c.content);
        const m = TIMEOUT_BACKGROUNDED_RE.exec(text);
        if (m) {
          starts.set(c.tool_use_id, {
            toolUseId: c.tool_use_id,
            taskId: m[1]!,
            source: "timeout_backgrounded",
          });
        }
      }
    }
  }

  const pendingTasks = [...starts.values()].filter(
    (t) => !completedToolUseIds.has(t.toolUseId),
  );
  // A wakeup is pending unless a plain user prompt LANDED AFTER it (= it fired).
  const pendingWakeup = lastWakeupIdx >= 0 && lastPlainUserIdx <= lastWakeupIdx;

  return { pendingTasks, pendingWakeup, skippedLines };
}

/**
 * Read + parse a transcript file, fail-LOUD (Issue #342 review condition 3):
 * an unreadable or empty transcript returns `{ ok: false }` so callers report
 * `completion: unknown` instead of silently treating the run as clean — the
 * exact self-defeat the fix exists to prevent.
 */
export function probePendingWork(transcriptPath: string): PendingWorkProbe {
  let text: string;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `transcript unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (text.trim() === "") {
    return { ok: false, error: "transcript is empty" };
  }
  return { ok: true, value: parsePendingWork(text) };
}

/** Human-readable one-line summary for reports / hook block reasons. */
export function describePendingWork(work: PendingWork): string {
  const parts: string[] = [];
  if (work.pendingTasks.length > 0) {
    const ids = work.pendingTasks
      .map((t) => t.taskId ?? t.toolUseId)
      .join(", ");
    parts.push(`未完了の背景タスク ${work.pendingTasks.length} 件 (${ids})`);
  }
  if (work.pendingWakeup) {
    parts.push("未発火の ScheduleWakeup 予約");
  }
  return parts.join(" / ");
}
