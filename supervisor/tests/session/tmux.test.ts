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
 * other error. We verify both branches by mocking child_process.execFileSync
 * (Issue #97 switched from execSync(template) to execFileSync(argv)).
 */

let mockExecFileSyncImpl: () => string = () => "";

// Spy-wrapped mock so we can assert the file/argv/options passed to
// execFileSync (#117 follow-up: gemini medium #3142222781).
const mockExecFileSync = mock((..._args: unknown[]) => mockExecFileSyncImpl());

mock.module("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

const { ensureSocketConfigured, TMUX_PATH, TMUX_SOCKET } = await import(
  "../../src/session/tmux"
);

function setupWarnSpy() {
  return spyOn(console, "warn").mockImplementation(() => {});
}

describe("ensureSocketConfigured unhappy-path (#85)", () => {
  // Hoisted to beforeEach/afterEach so a failing assertion never leaves a
  // stale spy attached to console.warn (#117 follow-up: gemini medium
  // #3142222783).
  let warnSpy: ReturnType<typeof setupWarnSpy>;

  beforeEach(() => {
    mockExecFileSyncImpl = () => "";
    mockExecFileSync.mockClear();
    warnSpy = setupWarnSpy();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("warns when execFileSync throws an error other than 'no server running'", () => {
    mockExecFileSyncImpl = () => {
      throw new Error("EACCES: permission denied, /tmp/tmux-501");
    };

    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy.mock.calls[0]!;
    expect(firstCall[0]).toBe("[tmux] ensureSocketConfigured failed:");
    expect(firstCall[1]).toBeInstanceOf(Error);
  });

  test("stays silent when execFileSync throws 'no server running' (first-call case)", () => {
    mockExecFileSyncImpl = () => {
      throw new Error("no server running on /tmp/tmux-501/claude-hub");
    };

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("stays silent when execFileSync succeeds", () => {
    mockExecFileSyncImpl = () => "";

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("matches 'no server running' regex case-insensitively", () => {
    mockExecFileSyncImpl = () => {
      throw new Error("No Server Running");
    };

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("re-runs and re-warns on every invocation (no memoisation by design)", () => {
    mockExecFileSyncImpl = () => {
      throw new Error("EBUSY: tmux socket is locked");
    };

    ensureSocketConfigured();
    ensureSocketConfigured();
    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  test("preserves the original Error instance in the warning payload", () => {
    const customError = new Error("ENOSPC: no space left on device");
    mockExecFileSyncImpl = () => {
      throw customError;
    };

    ensureSocketConfigured();

    expect(warnSpy.mock.calls[0]![1]).toBe(customError);
  });

  test("passes raw non-Error thrown value through to console.warn", () => {
    // Plain object: not an Error instance, and String(err) === "[object Object]"
    // which does NOT match /no server running/i, so the isNoServer guard
    // correctly falls through to the warn branch (#117 follow-up: coderabbit
    // minor #3142223332).
    const thrown = { code: "EPERM", path: "/tmp/tmux-501" };
    mockExecFileSyncImpl = () => {
      throw thrown;
    };

    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toBe(thrown);
  });

  test("invokes execFileSync with the expected tmux file, argv and options", () => {
    mockExecFileSyncImpl = () => "";

    ensureSocketConfigured();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const call = mockExecFileSync.mock.calls[0]!;
    const file = call[0] as string;
    const argv = call[1] as string[];
    const opts = call[2] as { timeout?: number; stdio?: string };

    // argv form (Issue #97): file is the tmux binary; the exact argv asserts
    // both that every option token is a discrete element AND that the two ";"
    // separators sit between the three set-option groups (an exact match, so a
    // mis-placed or extra separator fails — `arrayContaining` would not catch
    // that).
    expect(file).toBe(TMUX_PATH);
    expect(argv).toEqual([
      "-L", TMUX_SOCKET,
      "set-option", "-g", "mouse", "off", ";",
      "set-option", "-g", "mode-keys", "emacs", ";",
      "set-option", "-g", "history-limit", "10000",
    ]);
    expect(opts).toMatchObject({ timeout: 3000, stdio: "pipe" });
  });
});
