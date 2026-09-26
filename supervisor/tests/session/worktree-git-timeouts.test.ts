import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * PR #484 review (Discord E2E FAIL): resuming a hub-work session whose
 * worktree had been removed hung the Discord interaction at "考え中"
 * indefinitely — no tmux session, no sessions.db row, no console output at
 * all, even after 1+ minute.
 *
 * Root cause: `realGitGhRunner` (this module) is the ONLY external-I/O layer
 * in the entire `/session resume` path that never bounds its subprocess calls
 * with a `timeout`. `realTmuxAdapter` (adapters.ts, Issue #222/#227) passes a
 * positive `timeout` to every `execFile` call specifically so a wedged
 * subprocess can never hang the single-process event loop forever — but the
 * git/gh calls this resume-recovery path depends on
 * (`recoverWorktreeForResume` → `recreateWorktreeForExistingBranch` →
 * `branchExists` / `addWorktreeFromBranch`) were migrated to the async
 * `execFile` under the same Issue #227 (see the module doc comment) WITHOUT
 * ever getting the equivalent timeout. Async only keeps the EVENT LOOP free
 * while the call is in flight — it does not bound how long the call itself
 * can take. A stuck/contended git process (e.g. a held `.git` lock from a
 * concurrent worktree operation on the same repo — exactly claude-hub's own
 * multi-worktree Supervisor architecture) or a stalled network fetch/`gh api`
 * call therefore hangs `resumeSession()` forever with zero observability:
 * none of `recoverWorktreeForResume`'s own `console.log`/`console.warn`
 * calls fire because the `await` never returns, so nothing print()s and the
 * `handleResume` catch block (which would otherwise turn a rejection into a
 * sanitized Discord reply) never even gets a chance to run.
 *
 * This test pins the FIX: every `realGitGhRunner` method that shells out to
 * git/gh passes a positive, bounded `timeout` to `execFile`, mirroring
 * `realTmuxAdapter`'s established contract (`tests/session/adapters.test.ts`,
 * "realTmuxAdapter tmux call timeouts (#222 / #227)"). With a timeout in
 * place, a wedged git/gh subprocess rejects after a bounded time instead of
 * hanging forever, and that rejection propagates through
 * `recoverWorktreeForResume` → `resumeSession()` → `handleResume`'s existing
 * catch → `sanitizedFailureNotice` + `safeRespond`, so the user gets a
 * failure message instead of an interaction stuck at "考え中" forever.
 */

interface RecordedCall {
  file: string;
  args: readonly string[];
  opts?: { timeout?: number; cwd?: string; encoding?: string };
}

let execFileCalls: RecordedCall[] = [];
/** When set, the next execFile callback rejects with this error. */
let execFileError: unknown = null;
/** stdout the next execFile callback resolves with (success path). */
let execFileStdout = "";

// promisify(execFile) invokes the fn as fn(file, args, opts, cb): the callback
// is always the final argument, opts (carrying our `timeout`) is the 3rd —
// same shape as tests/session/adapters.test.ts's tmux mock, reused here for
// the git/gh runner.
const mockExecFile = mock((...callArgs: unknown[]) => {
  const file = callArgs[0] as string;
  const args = callArgs[1] as readonly string[];
  const opts = callArgs[2] as
    | { timeout?: number; cwd?: string; encoding?: string }
    | undefined;
  const cb = callArgs[callArgs.length - 1] as (
    err: unknown,
    result: { stdout: string; stderr: string }
  ) => void;
  execFileCalls.push({ file, args, opts });
  if (execFileError) cb(execFileError, { stdout: "", stderr: "" });
  else cb(null, { stdout: execFileStdout, stderr: "" });
  return {} as import("child_process").ChildProcess;
});

const childProcess = await import("child_process");
mock.module("child_process", () => ({
  ...childProcess,
  execFile: mockExecFile,
}));

const { realGitGhRunner } = await import("../../src/session/worktree");

beforeEach(() => {
  execFileCalls = [];
  execFileError = null;
  execFileStdout = "";
  mockExecFile.mockClear();
});

function lastTimeout(): number | undefined {
  return execFileCalls[execFileCalls.length - 1]?.opts?.timeout;
}

describe("realGitGhRunner git/gh call timeouts (PR #484 review, Discord E2E hang)", () => {
  test("branchExists passes a positive timeout", async () => {
    await realGitGhRunner.branchExists("/repo", "some-branch");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("defaultBranch's gh api call passes a positive timeout", async () => {
    execFileStdout = "main\n";
    await realGitGhRunner.defaultBranch("/repo");
    expect(execFileCalls[0]?.file).toBe("gh");
    expect(execFileCalls[0]?.opts?.timeout).toBeGreaterThan(0);
  });

  test("defaultBranch's git-remote fallback passes a positive timeout", async () => {
    // First call (gh api) fails → falls through to `git remote` / `symbolic-ref`.
    execFileError = new Error("gh: command not found");
    await realGitGhRunner.defaultBranch("/repo");
    // `git remote` is the 2nd call (index 1); it errors too (empty stdout) so
    // symbolic-ref is never reached, but the timeout must still be present on
    // this git call.
    expect(execFileCalls[1]?.file).toBe("git");
    expect(execFileCalls[1]?.opts?.timeout).toBeGreaterThan(0);
  });

  test("fetchRemoteBranch passes a positive timeout (network-bound call)", async () => {
    await realGitGhRunner.fetchRemoteBranch("/repo", "origin", "main");
    expect(execFileCalls[0]?.args).toContain("fetch");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("addWorktreeFromBranch passes a positive timeout", async () => {
    await realGitGhRunner.addWorktreeFromBranch("/repo", "/repo/.claude/worktrees/x", "x");
    expect(execFileCalls[0]?.args).toContain("add");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("addWorktreeNewBranch passes a positive timeout", async () => {
    await realGitGhRunner.addWorktreeNewBranch(
      "/repo",
      "/repo/.claude/worktrees/x",
      "x",
      "origin/main",
    );
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("removeWorktree passes a positive timeout", async () => {
    await realGitGhRunner.removeWorktree("/repo", "/repo/.claude/worktrees/x");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("worktreeStatus passes a positive timeout", async () => {
    execFileStdout = "";
    await realGitGhRunner.worktreeStatus("/repo", "/repo/.claude/worktrees/x");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("a timed-out git call rejects (not hangs) so the caller's catch can run", async () => {
    // Simulates the production symptom: a wedged/contended git process. With a
    // bounded timeout, Node's execFile rejects with ETIMEDOUT instead of the
    // Promise hanging forever.
    execFileError = Object.assign(new Error("ETIMEDOUT"), { killed: true, signal: "SIGTERM" });
    await expect(
      realGitGhRunner.addWorktreeFromBranch("/repo", "/repo/.claude/worktrees/x", "x"),
    ).rejects.toThrow();
  });
});
