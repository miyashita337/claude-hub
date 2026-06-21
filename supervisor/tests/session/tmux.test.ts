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
 * Tests for Issue #85: ensureSocketConfigured unhappy-path coverage.
 *
 * The function in src/session/tmux.ts swallows `no server running` (expected
 * on the very first call before any tmux server exists) and warns on any
 * other error. We verify both branches by mocking child_process.execFile
 * (Issue #97 switched from execSync(template) to execFileSync(argv); Issue #227
 * PR-4 then switched execFileSync → the async `execFile`, so the function is
 * async and we mock the callback-style `execFile` that `promisify` drives).
 */

import * as childProcess from "child_process";

/** Programmed outcome for the next execFile callback: reject with this error. */
let execFileError: unknown = null;
/** stdout the callback resolves with on the success path. */
let execFileStdout = "";

interface RecordedCall {
  file: string;
  args: readonly string[];
  opts?: { timeout?: number };
}
let execFileCalls: RecordedCall[] = [];

// promisify(execFile) invokes the fn as fn(file, args, opts, cb): the callback
// is always the final argument. Resolve `{ stdout, stderr }` on success, or
// invoke the callback with the programmed error (the error's `.stderr` carries
// tmux's "no server running" message, matching the real execFile shape).
const mockExecFile = mock((...callArgs: unknown[]) => {
  const file = callArgs[0] as string;
  const args = callArgs[1] as readonly string[];
  const opts = callArgs[2] as { timeout?: number } | undefined;
  const cb = callArgs[callArgs.length - 1] as (
    err: unknown,
    result: { stdout: string; stderr: string }
  ) => void;
  execFileCalls.push({ file, args, opts });
  if (execFileError) cb(execFileError, { stdout: "", stderr: "" });
  else cb(null, { stdout: execFileStdout, stderr: "" });
  return {} as childProcess.ChildProcess;
});

// Re-export the rest of node:child_process untouched so other modules loaded in
// this test process keep working.
mock.module("child_process", () => ({
  ...childProcess,
  execFile: mockExecFile,
}));

const { ensureSocketConfigured, TMUX_PATH, TMUX_SOCKET } = await import(
  "../../src/session/tmux"
);

function setupWarnSpy() {
  return spyOn(console, "warn").mockImplementation(() => {});
}

/** Build an Error whose `.stderr` carries tmux's message, like a real execFile reject. */
function execFileReject(message: string): Error & { stderr: string } {
  const e = new Error(message) as Error & { stderr: string };
  // The real execFile reject surfaces the child's stderr on the error object;
  // tmux prints "no server running" to stderr, not the error message itself.
  e.stderr = message;
  return e;
}

describe("ensureSocketConfigured unhappy-path (#85)", () => {
  // Hoisted to beforeEach/afterEach so a failing assertion never leaves a
  // stale spy attached to console.warn (#117 follow-up: gemini medium
  // #3142222783).
  let warnSpy: ReturnType<typeof setupWarnSpy>;

  beforeEach(() => {
    execFileError = null;
    execFileStdout = "";
    execFileCalls = [];
    mockExecFile.mockClear();
    warnSpy = setupWarnSpy();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("warns when execFile rejects with an error other than 'no server running'", async () => {
    execFileError = execFileReject("EACCES: permission denied, /tmp/tmux-501");

    await ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy.mock.calls[0]!;
    expect(firstCall[0]).toBe("[tmux] ensureSocketConfigured failed:");
    expect(firstCall[1]).toBeInstanceOf(Error);
  });

  test("stays silent when execFile rejects with 'no server running' (first-call case)", async () => {
    execFileError = execFileReject("no server running on /tmp/tmux-501/claude-hub");

    await ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("stays silent when execFile succeeds", async () => {
    execFileStdout = "";

    await ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("matches 'no server running' regex case-insensitively", async () => {
    execFileError = execFileReject("No Server Running");

    await ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("re-runs and re-warns on every invocation (no memoisation by design)", async () => {
    execFileError = execFileReject("EBUSY: tmux socket is locked");

    await ensureSocketConfigured();
    await ensureSocketConfigured();
    await ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  test("preserves the original Error instance in the warning payload", async () => {
    const customError = execFileReject("ENOSPC: no space left on device");
    execFileError = customError;

    await ensureSocketConfigured();

    expect(warnSpy.mock.calls[0]![1]).toBe(customError);
  });

  test("passes raw non-Error rejected value through to console.warn", async () => {
    // Plain object: not an Error instance, and String(err) === "[object Object]"
    // which does NOT match /no server running/i, so the isNoServer guard
    // correctly falls through to the warn branch (#117 follow-up: coderabbit
    // minor #3142223332).
    const thrown = { code: "EPERM", path: "/tmp/tmux-501" };
    execFileError = thrown;

    await ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toBe(thrown);
  });

  test("invokes execFile with the expected tmux file, argv and options", async () => {
    execFileStdout = "";

    await ensureSocketConfigured();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const call = execFileCalls[0]!;

    // argv form (Issue #97): file is the tmux binary; the exact argv asserts
    // both that every option token is a discrete element AND that the two ";"
    // separators sit between the three set-option groups (an exact match, so a
    // mis-placed or extra separator fails — `arrayContaining` would not catch
    // that).
    expect(call.file).toBe(TMUX_PATH);
    expect(call.args).toEqual([
      "-L", TMUX_SOCKET,
      "set-option", "-g", "mouse", "off", ";",
      "set-option", "-g", "mode-keys", "emacs", ";",
      "set-option", "-g", "history-limit", "10000",
    ]);
    // PR-4: stdio: "pipe" is gone (execFile buffers by default); the timeout is
    // unchanged.
    expect(call.opts).toMatchObject({ timeout: 3000 });
  });
});
