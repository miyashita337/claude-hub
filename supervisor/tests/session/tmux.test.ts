import { describe, test, expect, mock, spyOn } from "bun:test";

/**
 * Tests for Issue #85: ensureSocketConfigured unhappy-path coverage.
 *
 * The function in src/session/tmux.ts swallows `no server running` (expected
 * on the very first call before any tmux server exists) and warns on any
 * other error. We verify both branches by mocking child_process.execSync.
 */

let mockExecSyncImpl: () => string = () => "";

mock.module("child_process", () => ({
  execSync: () => mockExecSyncImpl(),
}));

const { ensureSocketConfigured } = await import("../../src/session/tmux");

describe("ensureSocketConfigured unhappy-path (#85)", () => {
  test("warns when execSync throws an error other than 'no server running'", () => {
    mockExecSyncImpl = () => {
      throw new Error("EACCES: permission denied, /tmp/tmux-501");
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy.mock.calls[0]!;
    expect(firstCall[0]).toBe("[tmux] ensureSocketConfigured failed:");
    expect(firstCall[1]).toBeInstanceOf(Error);

    warnSpy.mockRestore();
  });

  test("stays silent when execSync throws 'no server running' (first-call case)", () => {
    mockExecSyncImpl = () => {
      throw new Error("no server running on /tmp/tmux-501/claude-hub");
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  test("stays silent when execSync succeeds", () => {
    mockExecSyncImpl = () => "";
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  test("matches 'no server running' regex case-insensitively", () => {
    mockExecSyncImpl = () => {
      throw new Error("No Server Running");
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    ensureSocketConfigured();

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  test("re-runs and re-warns on every invocation (no memoisation by design)", () => {
    mockExecSyncImpl = () => {
      throw new Error("EBUSY: tmux socket is locked");
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    ensureSocketConfigured();
    ensureSocketConfigured();
    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(3);

    warnSpy.mockRestore();
  });

  test("preserves the original Error instance in the warning payload", () => {
    const customError = new Error("ENOSPC: no space left on device");
    mockExecSyncImpl = () => {
      throw customError;
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    ensureSocketConfigured();

    expect(warnSpy.mock.calls[0]![1]).toBe(customError);

    warnSpy.mockRestore();
  });

  test("handles non-Error throw values via String(err) coercion", () => {
    mockExecSyncImpl = () => {
      throw "permission denied raw string";
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    ensureSocketConfigured();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toBe("permission denied raw string");

    warnSpy.mockRestore();
  });
});
