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
 * (ETIMEDOUT) as "session exited".
 *
 * Under tmux-server contention (Issue #222 symptom) `has-session` can time out
 * at TMUX_CALL_TIMEOUT_MS even though the session is alive. The previous catch
 * discarded `warnIfTmuxTimeout`'s return value and always returned `false`, so
 * `watchTmuxSession` (manager.ts) tore down a live session and orphaned the
 * user's work ("started then immediately exited"). A timeout means "liveness
 * unknown" — for a teardown gate we must assume alive (return true). A genuine
 * "no such session" surfaces as a non-timeout error and must still return false.
 *
 * We mock child_process.execFileSync (same approach as tmux.test.ts).
 */

import * as childProcess from "child_process";

let mockExecFileSyncImpl: (...args: unknown[]) => string = () => "";
const mockExecFileSync = mock((...args: unknown[]) =>
  mockExecFileSyncImpl(...args)
);

// Preserve the rest of child_process (relay-server / iterm2 in adapters.ts's
// import graph use `spawn`) and override only execFileSync.
mock.module("child_process", () => ({
  ...childProcess,
  execFileSync: mockExecFileSync,
}));

const { realTmuxAdapter } = await import("../../src/session/adapters");

function makeTimeoutError(): NodeJS.ErrnoException {
  const err = new Error(
    "spawnSync /opt/homebrew/bin/tmux ETIMEDOUT"
  ) as NodeJS.ErrnoException;
  err.code = "ETIMEDOUT";
  return err;
}

describe("realTmuxAdapter.hasSession ETIMEDOUT handling (#238)", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockExecFileSyncImpl = () => "";
    mockExecFileSync.mockClear();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("returns true (assume alive) when has-session times out (ETIMEDOUT)", () => {
    mockExecFileSyncImpl = () => {
      throw makeTimeoutError();
    };

    // Regression: a transient 2s timeout must NOT be read as an exit, otherwise
    // watchTmuxSession tears down a live session.
    expect(realTmuxAdapter.hasSession("claude-151520552301")).toBe(true);
    // Observability (#222): the timeout is still surfaced via console.warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("returns false when the session genuinely does not exist (non-timeout error)", () => {
    mockExecFileSyncImpl = () => {
      throw new Error("can't find session: claude-dead");
    };

    expect(realTmuxAdapter.hasSession("claude-dead")).toBe(false);
    // A real "no session" is not a timeout, so no timeout warning.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("returns true when has-session succeeds (session present)", () => {
    mockExecFileSyncImpl = () => "";

    expect(realTmuxAdapter.hasSession("claude-alive")).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
