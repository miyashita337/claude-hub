import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parsePendingWork,
  probePendingWork,
  deriveTranscriptPath,
  describePendingWork,
} from "../../src/session/pending-work";

/**
 * Issue #342: deterministic pending-work detection. Fixture lines mirror the
 * REAL transcript shapes observed in the two live silent failures:
 *   - #338: background E2E + ScheduleWakeup reservation left at turn end
 *   - agent-base#456: foreground Bash auto-moved to background on its 600s
 *     timeout ("moved to the background (ID: …)" tool_result literal), then
 *     the turn ended while it was still running.
 */

/** An assistant entry carrying one tool_use content item. */
function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
}

/** A user entry carrying one tool_result content item. */
function userToolResult(toolUseId: string, content: unknown): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  });
}

/** The completion notification as it appears in `queue-operation` entries. */
function queueNotification(toolUseId: string, taskId: string): string {
  return JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    content:
      `<task-notification>\n<task-id>${taskId}</task-id>\n` +
      `<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
  });
}

/** A plain injected user prompt (what a fired ScheduleWakeup looks like). */
function plainUserPrompt(text: string): string {
  return JSON.stringify({ type: "user", message: { content: text } });
}

describe("parsePendingWork", () => {
  test("explicit run_in_background start with no notification is pending", () => {
    const jsonl = [
      assistantToolUse("toolu_bg1", "Bash", {
        command: "make test",
        run_in_background: true,
      }),
    ].join("\n");

    const work = parsePendingWork(jsonl);
    expect(work.pendingTasks).toHaveLength(1);
    expect(work.pendingTasks[0]).toEqual({
      toolUseId: "toolu_bg1",
      source: "run_in_background",
    });
    expect(work.pendingWakeup).toBe(false);
  });

  test("a matching <task-notification> completes the task (queue-operation shape)", () => {
    const jsonl = [
      assistantToolUse("toolu_bg1", "Bash", { run_in_background: true }),
      queueNotification("toolu_bg1", "bas5ws1zh"),
    ].join("\n");

    expect(parsePendingWork(jsonl).pendingTasks).toHaveLength(0);
  });

  test("timeout-backgrounded Bash (agent-base#456 shape) is pending until notified", () => {
    // Real literal from the #456 transcript (tool_result of toolu_01EKmsva…).
    const movedText =
      "Command did not complete within its 600s timeout and was moved to the " +
      "background (ID: bas5ws1zh). Output is being written to: /tmp/x.output.";
    const started = [
      assistantToolUse("toolu_fg1", "Bash", { command: "make test", timeout: 600000 }),
      userToolResult("toolu_fg1", movedText),
    ];

    const pending = parsePendingWork(started.join("\n"));
    expect(pending.pendingTasks).toEqual([
      { toolUseId: "toolu_fg1", taskId: "bas5ws1zh", source: "timeout_backgrounded" },
    ]);

    const completed = parsePendingWork(
      [...started, queueNotification("toolu_fg1", "bas5ws1zh")].join("\n"),
    );
    expect(completed.pendingTasks).toHaveLength(0);
  });

  test("tool_result content as text-array is also recognised", () => {
    const jsonl = [
      assistantToolUse("toolu_fg2", "Bash", { command: "sleep 1000" }),
      userToolResult("toolu_fg2", [
        { type: "text", text: "… was moved to the background (ID: abc123zzz). …" },
      ]),
    ].join("\n");

    expect(parsePendingWork(jsonl).pendingTasks).toEqual([
      { toolUseId: "toolu_fg2", taskId: "abc123zzz", source: "timeout_backgrounded" },
    ]);
  });

  test("non-stop ScheduleWakeup with no later plain user prompt is pending (#338 shape)", () => {
    const jsonl = [
      assistantToolUse("toolu_w1", "ScheduleWakeup", {
        delaySeconds: 1800,
        prompt: "resume E2E collection",
      }),
    ].join("\n");

    expect(parsePendingWork(jsonl).pendingWakeup).toBe(true);
  });

  test("ScheduleWakeup stop:true cancels the reservation", () => {
    const jsonl = [
      assistantToolUse("toolu_w1", "ScheduleWakeup", { delaySeconds: 1800, prompt: "x" }),
      assistantToolUse("toolu_w2", "ScheduleWakeup", { stop: true }),
    ].join("\n");

    expect(parsePendingWork(jsonl).pendingWakeup).toBe(false);
  });

  test("a plain user prompt AFTER the wakeup means it fired (not pending)", () => {
    const jsonl = [
      assistantToolUse("toolu_w1", "ScheduleWakeup", { delaySeconds: 60, prompt: "go on" }),
      plainUserPrompt("go on"),
    ].join("\n");

    expect(parsePendingWork(jsonl).pendingWakeup).toBe(false);
  });

  test("a task-notification user injection does NOT count as a fired wakeup", () => {
    const jsonl = [
      assistantToolUse("toolu_bg1", "Bash", { run_in_background: true }),
      assistantToolUse("toolu_w1", "ScheduleWakeup", { delaySeconds: 60, prompt: "x" }),
      plainUserPrompt("<task-notification>…</task-notification>"),
    ].join("\n");

    expect(parsePendingWork(jsonl).pendingWakeup).toBe(true);
  });

  test("a tool_result-carrying user entry does NOT count as a fired wakeup", () => {
    const jsonl = [
      assistantToolUse("toolu_w1", "ScheduleWakeup", { delaySeconds: 60, prompt: "x" }),
      userToolResult("toolu_other", "some result"),
    ].join("\n");

    expect(parsePendingWork(jsonl).pendingWakeup).toBe(true);
  });

  test("clean transcript (no background, no wakeup) reports nothing pending", () => {
    const jsonl = [
      plainUserPrompt("/impl 42"),
      assistantToolUse("toolu_x", "Bash", { command: "git status" }),
      userToolResult("toolu_x", "clean"),
    ].join("\n");

    const work = parsePendingWork(jsonl);
    expect(work.pendingTasks).toHaveLength(0);
    expect(work.pendingWakeup).toBe(false);
    expect(work.skippedLines).toBe(0);
  });

  test("unparsable lines are skipped and counted, not fatal", () => {
    const jsonl = [
      "not json at all {",
      assistantToolUse("toolu_bg1", "Bash", { run_in_background: true }),
    ].join("\n");

    const work = parsePendingWork(jsonl);
    expect(work.skippedLines).toBe(1);
    expect(work.pendingTasks).toHaveLength(1);
  });
});

describe("probePendingWork (fail-loud file wrapper)", () => {
  test("missing transcript returns ok:false, never a clean verdict", () => {
    const probe = probePendingWork("/nonexistent/path/to/transcript.jsonl");
    expect(probe.ok).toBe(false);
  });

  test("empty transcript returns ok:false", () => {
    const dir = mkdtempSync(join(tmpdir(), "pending-work-"));
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, "   \n", "utf8");
    expect(probePendingWork(p).ok).toBe(false);
  });

  test("readable transcript parses through to a value", () => {
    const dir = mkdtempSync(join(tmpdir(), "pending-work-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      assistantToolUse("toolu_bg1", "Bash", { run_in_background: true }),
      "utf8",
    );
    const probe = probePendingWork(p);
    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.value.pendingTasks).toHaveLength(1);
  });
});

describe("deriveTranscriptPath", () => {
  test("folds every non-alphanumeric char to '-' (verified real-dir shape)", () => {
    // Real observed mapping: /Users/x/agent-base/.claude/worktrees/corp-dispatch-456
    // → ~/.claude/projects/-Users-x-agent-base--claude-worktrees-corp-dispatch-456/
    const p = deriveTranscriptPath(
      "/Users/x/agent-base/.claude/worktrees/corp-dispatch-456",
      "821ceb5d-002e-48f2-b103-ec84af54ed57",
      "/home/fake",
    );
    expect(p).toBe(
      "/home/fake/.claude/projects/-Users-x-agent-base--claude-worktrees-corp-dispatch-456/821ceb5d-002e-48f2-b103-ec84af54ed57.jsonl",
    );
  });

  test("underscores fold to '-' too (team_salary shape)", () => {
    const p = deriveTranscriptPath("/Users/x/team_salary", "sid", "/h");
    expect(p).toBe("/h/.claude/projects/-Users-x-team-salary/sid.jsonl");
  });
});

describe("describePendingWork", () => {
  test("mentions tasks (preferring task ids) and the wakeup", () => {
    const s = describePendingWork({
      pendingTasks: [
        { toolUseId: "toolu_a", source: "run_in_background" },
        { toolUseId: "toolu_b", taskId: "bas5ws1zh", source: "timeout_backgrounded" },
      ],
      pendingWakeup: true,
      skippedLines: 0,
    });
    expect(s).toContain("2 件");
    expect(s).toContain("toolu_a");
    expect(s).toContain("bas5ws1zh");
    expect(s).toContain("ScheduleWakeup");
  });

  test("empty when nothing is pending", () => {
    expect(
      describePendingWork({ pendingTasks: [], pendingWakeup: false, skippedLines: 0 }),
    ).toBe("");
  });
});
