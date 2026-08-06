// supervisor/tests/hooks/headless-pending-guard.test.ts (Issue #342 Layer 1)
//
// Black-box test for hooks/headless-pending-guard.ts: the Stop hook injected
// into headless dispatch children. Runs the hook as a real subprocess (the
// same way `claude -p` invokes it) with fixture transcripts and asserts the
// block / allow decisions, the block bound, and the kill switch.
import { test, expect, describe } from "bun:test";
import { spawnSync } from "child_process";
import { resolve } from "path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/headless-pending-guard.ts");

/** Run the hook once with the given Stop-event stdin and env; capture output. */
function runHook(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? -1 };
}

function pendingTranscript(): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_bg1",
            name: "Bash",
            input: { command: "make test", run_in_background: true },
          },
        ],
      },
    }) + "\n"
  );
}

function cleanTranscript(): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    }) + "\n"
  );
}

function writeTranscript(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-guard-test-"));
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, content, "utf8");
  return p;
}

describe("headless-pending-guard hook", () => {
  test("blocks the stop while a background task is pending, with instructions", () => {
    const transcript = writeTranscript(pendingTranscript());
    const sessionId = `test-block-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r = runHook({
      session_id: sessionId,
      transcript_path: transcript,
      stop_hook_active: false,
    });

    expect(r.exitCode).toBe(0);
    const decision = JSON.parse(r.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("toolu_bg1");
    expect(decision.reason).toContain("TaskOutput");
    expect(decision.reason).toContain("#342");
    // A counter file now bounds the loop.
    const counter = join(tmpdir(), `headless-pending-guard-${sessionId}.blocks`);
    expect(readFileSync(counter, "utf8").trim()).toBe("1");
  });

  test("allows the stop when nothing is pending and clears the counter", () => {
    const transcript = writeTranscript(cleanTranscript());
    const sessionId = `test-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const counter = join(tmpdir(), `headless-pending-guard-${sessionId}.blocks`);
    writeFileSync(counter, "3", "utf8"); // stale counter from earlier blocks

    const r = runHook({
      session_id: sessionId,
      transcript_path: transcript,
      stop_hook_active: true,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(existsSync(counter)).toBe(false);
  });

  test("stops blocking once the bound is reached (never wedges the worker)", () => {
    const transcript = writeTranscript(pendingTranscript());
    const sessionId = `test-bound-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const first = runHook(
      { session_id: sessionId, transcript_path: transcript },
      { HEADLESS_PENDING_GUARD_MAX_BLOCKS: "2" },
    );
    expect(JSON.parse(first.stdout).decision).toBe("block");

    const second = runHook(
      { session_id: sessionId, transcript_path: transcript },
      { HEADLESS_PENDING_GUARD_MAX_BLOCKS: "2" },
    );
    expect(JSON.parse(second.stdout).decision).toBe("block");

    // Bound reached → allow, and say so on stderr (observable, not silent).
    const third = runHook(
      { session_id: sessionId, transcript_path: transcript },
      { HEADLESS_PENDING_GUARD_MAX_BLOCKS: "2" },
    );
    expect(third.stdout.trim()).toBe("");
    expect(third.stderr).toContain("allowing stop");
    expect(third.exitCode).toBe(0);
  });

  test("unreadable transcript allows the stop and logs loudly (Layer 2 flags it)", () => {
    const r = runHook({
      session_id: `test-noread-${Date.now()}`,
      transcript_path: "/nonexistent/transcript.jsonl",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("allowing stop");
  });

  test("HEADLESS_PENDING_GUARD=off is a full kill switch", () => {
    const transcript = writeTranscript(pendingTranscript());
    const r = runHook(
      { session_id: `test-off-${Date.now()}`, transcript_path: transcript },
      { HEADLESS_PENDING_GUARD: "off" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("malformed stdin never breaks the stop (fail-open with a loud stderr)", () => {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: "not json",
      env: process.env,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("allowing stop");
  });
});
