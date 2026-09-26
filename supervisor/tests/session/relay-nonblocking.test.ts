import { test, expect, describe, mock, beforeEach } from "bun:test";

/**
 * Issue #227 (PR-1 / #249) AC-3: the relay send hot path must NOT block the Bun
 * single event loop.
 *
 * `relay.ts`'s `tmuxSend` / `ensurePaneNotInMode` used synchronous
 * `execFileSync`, so each tmux call froze the whole Supervisor for up to the
 * per-call timeout (2–7s). Under load the dialog-watchdog poll (#222) made this
 * cumulative. PR-1 moves them to `promisify(execFile)` + `await`, which runs the
 * tmux subprocess in the background and yields control back to the loop.
 *
 * This test mocks `child_process.execFile` so the tmux call "parks" (its
 * callback is held), then proves a *separately scheduled* macrotask
 * (`setTimeout(0)`) runs WHILE `tmuxSend` is in flight — i.e. the event loop
 * was free. A synchronous `execFileSync` would have run `tmuxSend` to completion
 * before any competing timer callback could fire, so the ordering asserted here
 * is impossible without the async conversion. This is the decisive,
 * deterministic non-blocking proof asked for by #249 AC-3.
 *
 * It uses `mock.module("child_process")`, which is process-global in Bun, so it
 * MUST run as its own isolated `bun test` step in ci.yml (same rationale as
 * adapters-hassession.test.ts / adapters.test.ts — see PR #247 / #248).
 */

import * as childProcess from "child_process";

/**
 * Captures the callback `promisify(execFile)` hands us so the test can decide
 * exactly when the simulated tmux subprocess "finishes". Set per-test.
 */
type ExecCb = (err: unknown, result: { stdout: string; stderr: string }) => void;
let onExec: ((cb: ExecCb) => void) | null = null;

// promisify(execFile) invokes the underlying fn as fn(file, args, opts, cb):
// the callback is always the final argument. Grab it positionally so the mock
// is robust to the (file, args, cb) vs (file, args, opts, cb) arities.
const mockExecFile = mock((...args: unknown[]) => {
  const cb = args[args.length - 1] as ExecCb;
  if (onExec) {
    onExec(cb);
  } else {
    cb(null, { stdout: "", stderr: "" });
  }
  return {} as childProcess.ChildProcess;
});

// Preserve the rest of child_process and override only execFile — relay.ts's
// import graph (tmux.ts / relay-server.ts) still needs the real spawn/exec.
mock.module("child_process", () => ({
  ...childProcess,
  execFile: mockExecFile,
}));

const { tmuxSend } = await import("../../src/session/relay");

describe("relay tmux I/O is non-blocking (#227 / #249 AC-3)", () => {
  beforeEach(() => {
    onExec = null;
    mockExecFile.mockClear();
  });

  test("tmuxSend yields the event loop while the tmux call is in flight", async () => {
    const order: string[] = [];

    // Park the tmux call: hold its callback instead of completing it. While
    // parked, control MUST return to the loop if the call is truly async.
    let release: (() => void) | null = null;
    onExec = (cb) => {
      order.push("exec-invoked");
      release = () => cb(null, { stdout: "", stderr: "" });
    };

    const sent = tmuxSend("nonblock-sess", ["-l", "payload"]).then(() => {
      order.push("tmuxSend-resolved");
    });

    // Competing macrotask scheduled AFTER kicking off tmuxSend. With a blocking
    // execFileSync, tmuxSend would have run to completion (and its .then
    // microtask would drain) before this 0ms timer's callback could run.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push("competing-task");
        resolve();
      }, 0)
    );

    // The tmux call started, the competing task ran, and tmuxSend is STILL
    // parked → the loop stayed free the whole time.
    expect(order).toContain("exec-invoked");
    expect(order).toContain("competing-task");
    expect(order).not.toContain("tmuxSend-resolved");

    // Now let the simulated subprocess finish and confirm tmuxSend completes.
    expect(release).not.toBeNull();
    release!();
    await sent;

    expect(order).toEqual(["exec-invoked", "competing-task", "tmuxSend-resolved"]);
  });

  test("tmuxSend resolves via the async path with no thrown error on success", async () => {
    // Default mock (onExec null) completes immediately with empty stdout.
    await expect(tmuxSend("ok-sess", ["C-m"])).resolves.toEqual({ retried: false });
    expect(mockExecFile).toHaveBeenCalled();
  });
});

/**
 * Issue #437: `tmuxSend`'s own transient-retry path (Issue #73 — a `send-keys`
 * that ETIMEDOUT or hit `not in a mode` is retried once after clearing any
 * stuck mode) can land the SAME literal on the pane TWICE — the first attempt
 * can have reached tmux before erroring to us, and the retry lands a second
 * time. Before this fix `tmuxSend` returned nothing, so `typeLiteral`'s
 * `typed` counter never learned about the extra send and a resulting
 * duplicate could be reported as `verified` instead of `duplicate`.
 *
 * This locks the return value in isolation (no real tmux, no real timeout
 * delay) via the same `execFile` mock used for the non-blocking proof above:
 * the first call errors with `ETIMEDOUT`, `ensurePaneNotInMode`'s
 * `display-message` probe succeeds, and the retried `send-keys` succeeds.
 */
describe("tmuxSend reports its own internal retry (#437)", () => {
  beforeEach(() => {
    onExec = null;
    mockExecFile.mockClear();
  });

  test("a transient ETIMEDOUT followed by a successful retry resolves { retried: true }", async () => {
    let callCount = 0;
    onExec = (cb) => {
      callCount++;
      if (callCount === 1) {
        // First send-keys attempt: transient timeout (Issue #73).
        cb(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), {
          stdout: "",
          stderr: "",
        });
        return;
      }
      // ensurePaneNotInMode's display-message probe (call 2, pane not in a
      // mode) and the retried send-keys (call 3) both succeed.
      cb(null, { stdout: "0", stderr: "" });
    };

    const result = await tmuxSend("retry-sess", ["-l", "hello"]);

    expect(result).toEqual({ retried: true });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  test("a clean send-keys with no error resolves { retried: false }", async () => {
    const result = await tmuxSend("clean-sess", ["-l", "hello"]);
    expect(result).toEqual({ retried: false });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  // Devils-advocate review (PR for #437): a "not in a mode" retry is NOT
  // symmetric with a timeout retry. The pane was in copy-mode, which consumes
  // `-l` input as a mode command (see ensurePaneNotInMode) instead of passing
  // it to the application — so the first attempt's literal never reached the
  // app, and only the successful retry delivers it, exactly once. Counting
  // this as `retried: true` (⇒ "two deliveries") would OVER-count and could
  // false-positive a healthy single delivery as `duplicate`.
  test("a 'not in a mode' error followed by a successful retry resolves { retried: false }", async () => {
    let callCount = 0;
    onExec = (cb) => {
      callCount++;
      if (callCount === 1) {
        // First send-keys attempt: pane was in copy-mode.
        cb(Object.assign(new Error("not in a mode"), { stderr: "not in a mode" }), {
          stdout: "",
          stderr: "",
        });
        return;
      }
      // ensurePaneNotInMode's display-message probe (call 2) and the retried
      // send-keys (call 3) both succeed.
      cb(null, { stdout: "0", stderr: "" });
    };

    const result = await tmuxSend("mode-retry-sess", ["-l", "hello"]);

    expect(result).toEqual({ retried: false });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });
});
