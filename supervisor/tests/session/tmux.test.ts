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
 * other error. We verify both branches by mocking child_process.execSync.
 */

let mockExecSyncImpl: () => string = () => "";

// Spy-wrapped mock so we can assert the command/options passed to execSync
// (#117 follow-up: gemini medium #3142222781).
const mockExecSync = mock((..._args: unknown[]) => mockExecSyncImpl());

mock.module("child_process", () => ({
  execSync: mockExecSync,
}));

const { ensureSocketConfigured, TMUX_CMD } = await import(
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
    mockExecSyncImpl = () => "";
    mockExecSync.mockClear();
    warnSpy = setupWarnSpy();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("warns when execSync throws an error other than 'no server running'", () => {
    mockExecSyncImpl = () => {
      throw new Error("EACCES: permission denied, /tmp/tmux-501");
    };

    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy.mock.calls[0]!;
    expect(firstCall[0]).toBe("[tmux] ensureSocketConfigured failed:");
    expect(firstCall[1]).toBeInstanceOf(Error);
  });

  test("stays silent when execSync throws 'no server running' (first-call case)", () => {
    mockExecSyncImpl = () => {
      throw new Error("no server running on /tmp/tmux-501/claude-hub");
    };

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("stays silent when execSync succeeds", () => {
    mockExecSyncImpl = () => "";

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("matches 'no server running' regex case-insensitively", () => {
    mockExecSyncImpl = () => {
      throw new Error("No Server Running");
    };

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("re-runs and re-warns on every invocation (no memoisation by design)", () => {
    mockExecSyncImpl = () => {
      throw new Error("EBUSY: tmux socket is locked");
    };

    ensureSocketConfigured();
    ensureSocketConfigured();
    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  test("preserves the original Error instance in the warning payload", () => {
    const customError = new Error("ENOSPC: no space left on device");
    mockExecSyncImpl = () => {
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
    mockExecSyncImpl = () => {
      throw thrown;
    };

    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toBe(thrown);
  });

  test("invokes execSync with the expected tmux command and options", () => {
    mockExecSyncImpl = () => "";

    ensureSocketConfigured();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const call = mockExecSync.mock.calls[0]!;
    const cmd = call[0] as string;
    const opts = call[1] as { timeout?: number; stdio?: string };
    expect(cmd).toContain(TMUX_CMD);
    expect(cmd).toContain("set-option -g mouse off");
    expect(cmd).toContain("set-option -g mode-keys emacs");
    expect(cmd).toContain("set-option -g history-limit 10000");
    expect(opts).toMatchObject({ timeout: 3000, stdio: "pipe" });
  });
});
