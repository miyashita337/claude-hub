import {
  describe,
  test,
  expect,
  mock,
  spyOn,
  beforeEach,
  afterEach,
} from "bun:test";

/**
 * Issue #238: `realTmuxAdapter.hasSession()` must NOT treat a tmux *timeout*
 * as "session exited".
 *
 * Under tmux-server contention (Issue #222 symptom) `has-session` can time out
 * at TMUX_CALL_TIMEOUT_MS even though the session is alive. The previous catch
 * discarded `warnIfTmuxTimeout`'s return value and always returned `false`, so
 * `watchTmuxSession` (manager.ts) tore down a live session and orphaned the
 * user's work ("started then immediately exited"). A timeout means "liveness
 * unknown" — for a teardown gate we must assume alive (return true). A genuine
 * "no such session" surfaces as a non-timeout error and must still return false.
 *
 * Issue #227 (PR-3): the adapter now uses the *async* `execFile`, so we mock
 * `child_process.execFile` (callback style — promisify(execFile) drives the
 * trailing callback). Crucially the async timeout shape is `killed === true`
 * (SIGTERM kill), NOT `code === "ETIMEDOUT"` (that was the sync spawn shape);
 * both must be honored by `warnIfTmuxTimeout` or #238 regresses on real load.
 */

import * as childProcess from "child_process";

/** Error the next execFile call should reject with (null = resolve success). */
let mockExecFileError: unknown = null;

// promisify(execFile) invokes the fn as fn(file, args, opts, cb); the callback
// is always the final argument. We resolve `{ stdout, stderr }` on success or
// reject with the programmed error.
const mockExecFile = mock((...args: unknown[]) => {
  const cb = args[args.length - 1] as (
    err: unknown,
    result: { stdout: string; stderr: string }
  ) => void;
  if (mockExecFileError) {
    cb(mockExecFileError, { stdout: "", stderr: "" });
  } else {
    cb(null, { stdout: "", stderr: "" });
  }
  return {} as childProcess.ChildProcess;
});

// Preserve the rest of child_process (relay-server / iterm2 in adapters.ts's
// import graph use `spawn`) and override only execFile.
mock.module("child_process", () => ({
  ...childProcess,
  execFile: mockExecFile,
}));

const { realTmuxAdapter } = await import("../../src/session/adapters");

/** Sync spawn timeout shape (pre-#227): `code === "ETIMEDOUT"`. Still honored. */
function makeEtimedoutError(): NodeJS.ErrnoException {
  const err = new Error(
    "execFile /opt/homebrew/bin/tmux ETIMEDOUT"
  ) as NodeJS.ErrnoException;
  err.code = "ETIMEDOUT";
  return err;
}

/**
 * Async `execFile` timeout shape (post-#227): the child is killed with the
 * `killSignal` (SIGTERM) when the `timeout` elapses, so `killed === true` and
 * `code` is left null. This is the realistic shape under tmux contention.
 */
function makeKilledTimeoutError(): NodeJS.ErrnoException & {
  killed: boolean;
  signal?: string;
} {
  const err = new Error(
    "execFile /opt/homebrew/bin/tmux has-session timed out"
  ) as NodeJS.ErrnoException & { killed: boolean; signal?: string };
  err.killed = true;
  err.signal = "SIGTERM";
  return err;
}

describe("realTmuxAdapter.hasSession timeout handling (#238 / #227)", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockExecFileError = null;
    mockExecFile.mockClear();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("returns true (assume alive) when has-session times out (ETIMEDOUT code)", async () => {
    mockExecFileError = makeEtimedoutError();

    // Regression: a transient 2s timeout must NOT be read as an exit, otherwise
    // watchTmuxSession tears down a live session.
    expect(await realTmuxAdapter.hasSession("claude-151520552301")).toBe(true);
    // Observability (#222): the timeout is still surfaced via console.warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("returns true (assume alive) when the async execFile is killed by timeout (killed=true)", async () => {
    // #227 regression: the async timeout shape (SIGTERM kill, killed=true, no
    // ETIMEDOUT code) must be treated as "liveness unknown → assume alive" too,
    // or the sync→async migration silently re-opens the #238 false-teardown.
    mockExecFileError = makeKilledTimeoutError();

    expect(await realTmuxAdapter.hasSession("claude-busy")).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("returns false when the session genuinely does not exist (non-timeout error)", async () => {
    // Real shape: tmux ran and exited 1 → promisify(execFile) sets the numeric
    // exit code on err.code.
    const err = new Error(
      "Command failed: tmux has-session -t claude-dead\ncan't find session: claude-dead"
    ) as Error & { code: number };
    err.code = 1;
    mockExecFileError = err;

    expect(await realTmuxAdapter.hasSession("claude-dead")).toBe(false);
    // Issue #369 B-1: the "no session" outcome is logged with its exit detail
    // so a false teardown can be diagnosed post-hoc (previously silent).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("claude-dead");
  });

  test("#369 B-1: returns true (assume alive) when the tmux spawn itself fails (EAGAIN)", async () => {
    // Under freeMem≈0% / load1≈50 the fork+exec of tmux can fail with
    // EAGAIN/ENOMEM before tmux ever runs. That is NOT evidence the session
    // exited — treating it as "exited" tears down a live session (the
    // handoff-96 false-teardown, Issue #369 cause B). errno-style spawn
    // failures carry a *string* code, unlike a tmux exit (numeric code).
    const err = new Error("spawn EAGAIN") as NodeJS.ErrnoException;
    err.code = "EAGAIN";
    err.errno = -35;
    mockExecFileError = err;

    expect(await realTmuxAdapter.hasSession("claude-loaded")).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("EAGAIN");
  });

  test("#369 B-1: returns true (assume alive) on ENOMEM spawn failure", async () => {
    const err = new Error("spawn ENOMEM") as NodeJS.ErrnoException;
    err.code = "ENOMEM";
    mockExecFileError = err;

    expect(await realTmuxAdapter.hasSession("claude-oom")).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("returns true when has-session succeeds (session present)", async () => {
    mockExecFileError = null;

    expect(await realTmuxAdapter.hasSession("claude-alive")).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
