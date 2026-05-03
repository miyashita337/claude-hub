// Smoke tests for scripts/cleanup-idle-claude.sh and scripts/list-claude-processes.sh
// These scripts inspect live host processes; tests verify CLI surface and
// non-destructive default behavior without asserting on specific live PIDs.
import { test, expect, describe } from "bun:test";
import { resolve } from "path";

const CLEANUP = resolve(import.meta.dir, "../../../scripts/cleanup-idle-claude.sh");
const LIST = resolve(import.meta.dir, "../../../scripts/list-claude-processes.sh");

async function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", script, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("cleanup-idle-claude.sh", () => {
  test("--help exits 0 and prints usage with expected sections", async () => {
    const { exitCode, stdout } = await run(CLEANUP, ["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--apply");
    expect(stdout).toContain("--idle-minutes");
    expect(stdout).toContain("CLEANUP_CLAUDE_ALLOWLIST_PIDS");
  });

  test("unknown flag exits 2", async () => {
    const { exitCode, stderr } = await run(CLEANUP, ["--bogus-flag"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown arg");
  });

  test("default run is dry-run (no signals sent) and exits 0", async () => {
    const { exitCode, stdout } = await run(CLEANUP, []);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/mode:\s*dry-run/);
    expect(stdout).toContain("[cleanup-idle-claude]");
  });

  test("--dry-run respects --idle-minutes override", async () => {
    const { exitCode, stdout } = await run(CLEANUP, ["--dry-run", "--idle-minutes", "1440"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/idle_threshold:\s*1440m/);
  });

  test("ALLOWLIST env protects listed PIDs from candidate set", async () => {
    const selfPid = process.pid;
    const { exitCode, stdout } = await run(CLEANUP, ["--dry-run"], {
      CLEANUP_CLAUDE_ALLOWLIST_PIDS: String(selfPid),
    });
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(new RegExp(`-\\s+\\w+\\s+${selfPid}\\s`));
  });
});

describe("list-claude-processes.sh", () => {
  test("runs and prints CATEGORY header", async () => {
    const { exitCode, stdout } = await run(LIST, []);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("CATEGORY");
    expect(stdout).toContain("PID");
    expect(stdout).toContain("CMD");
  });
});
