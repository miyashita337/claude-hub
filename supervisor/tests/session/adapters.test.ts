import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
  spyOn,
} from "bun:test";

/**
 * Issue #147 / #148 regression tests: every realTmuxAdapter method must reach
 * tmux via execFile + argv array so neither `command` nor `name` flow through
 * the calling shell.
 *
 * Pre-fix: `execSync(\`tmux new-session ... '${command}'\`)` re-parsed
 * `command` through the calling shell. A command containing
 * `--mcp-config '{"mcpServers":{}}'` would have its outer single quote
 * pair closed by the inner one, leaking the JSON into bash word-splitting
 * and bricking the claude session immediately on spawn (#147).
 *
 * Post-fix: every method uses execFile(TMUX_PATH, [..., name, ...]) so user
 * input cannot reach the shell at all.
 *
 * Issue #227 (PR-3): the adapter moved from synchronous `execFileSync` to the
 * async `execFile` (the methods now return Promises). We mock `child_process.execFile`
 * (callback style — promisify(execFile) drives the trailing callback) and a
 * single mutable controller (`execFileError` / `execFileStdout` / park) shapes
 * each call's outcome, so the tests await the adapter and assert the same argv /
 * timeout / observability contracts as before.
 */

import * as childProcess from "child_process";

interface RecordedCall {
  file: string;
  args: readonly string[];
  opts?: { timeout?: number };
}

let execFileCalls: RecordedCall[] = [];
/** When set, the next execFile callback rejects with this error. */
let execFileError: unknown = null;
/** stdout the next execFile callback resolves with (success path). */
let execFileStdout = "";
/** When set true, the callback is parked (held) until `releasePark()` runs. */
let parkNext = false;
let parkedSettle: (() => void) | null = null;
function releasePark(): void {
  const s = parkedSettle;
  parkedSettle = null;
  s?.();
}

// promisify(execFile) invokes the fn as fn(file, args, opts, cb): the callback
// is always the final argument, opts (with our `timeout`) is the 3rd. Resolve
// `{ stdout, stderr }` on success or reject with the programmed error.
const mockExecFile = mock((...callArgs: unknown[]) => {
  const file = callArgs[0] as string;
  const args = callArgs[1] as readonly string[];
  const opts = callArgs[2] as { timeout?: number } | undefined;
  const cb = callArgs[callArgs.length - 1] as (
    err: unknown,
    result: { stdout: string; stderr: string }
  ) => void;
  execFileCalls.push({ file, args, opts });
  const settle = () => {
    if (execFileError) cb(execFileError, { stdout: "", stderr: "" });
    else cb(null, { stdout: execFileStdout, stderr: "" });
  };
  if (parkNext) {
    parkedSettle = settle;
  } else {
    settle();
  }
  return {} as childProcess.ChildProcess;
});

// Re-export the rest of node:child_process untouched so other modules loaded in
// this test process (e.g. anything importing `spawn`) keep working.
mock.module("child_process", () => ({
  ...childProcess,
  execFile: mockExecFile,
}));

const { realTmuxAdapter } = await import("../../src/session/adapters");
const { TMUX_PATH, TMUX_ARGS } = await import("../../src/session/tmux");

beforeEach(() => {
  execFileCalls = [];
  execFileError = null;
  execFileStdout = "";
  parkNext = false;
  parkedSettle = null;
  mockExecFile.mockClear();
});

describe("realTmuxAdapter.newSession (#147)", () => {
  test("uses execFile with argv array (no shell parsing)", async () => {
    await realTmuxAdapter.newSession("claude-test", "echo hi");

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(execFileCalls[0]?.file).toBe(TMUX_PATH);
    expect(execFileCalls[0]?.args).toEqual([
      ...TMUX_ARGS,
      "new-session",
      "-d",
      "-s",
      "claude-test",
      "echo hi",
    ]);
  });

  test("preserves single quotes in command (the #147 regression)", async () => {
    // This is the exact pattern that broke Supervisor in #104:
    // --mcp-config '{"mcpServers":{}}' embedded in a longer chain.
    const command =
      `cd /tmp && exec claude --mcp-config '{"mcpServers":{}}'`;

    await realTmuxAdapter.newSession("claude-x", command);

    // The command must appear in argv VERBATIM — no quote balancing,
    // no escape-mangling, no truncation at the inner single quote.
    expect(execFileCalls[0]?.args.at(-1)).toBe(command);
  });

  test("preserves $-expansions, backticks, and brace seeds", async () => {
    // None of these should expand client-side. tmux is responsible for
    // running /bin/sh -c on this string inside the new session.
    const tricky =
      `export X=$HOME && echo \`date\` && touch {a,b,c}.txt && exec claude`;

    await realTmuxAdapter.newSession("claude-tricky", tricky);

    expect(execFileCalls[0]?.args.at(-1)).toBe(tricky);
  });
});

describe("realTmuxAdapter.killSession (#148 review)", () => {
  test("uses execFile with name as argv element (no shell)", async () => {
    await realTmuxAdapter.killSession("claude-test");

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(execFileCalls[0]?.file).toBe(TMUX_PATH);
    expect(execFileCalls[0]?.args).toEqual([
      ...TMUX_ARGS,
      "kill-session",
      "-t",
      "claude-test",
    ]);
  });

  test("neutralises shell-metacharacter injection via name", async () => {
    // The gemini review example. With the old execSync template literal
    // this would have run `reboot` on the host. argv array passing makes
    // the whole string a single argument to tmux's -t flag.
    const malicious = `x"; reboot; #`;

    await realTmuxAdapter.killSession(malicious);

    expect(execFileCalls[0]?.args.at(-1)).toBe(malicious);
  });
});

describe("realTmuxAdapter.hasSession (#148 review)", () => {
  test("returns true when execFile succeeds", async () => {
    expect(await realTmuxAdapter.hasSession("claude-test")).toBe(true);
    expect(execFileCalls[0]?.args).toEqual([
      ...TMUX_ARGS,
      "has-session",
      "-t",
      "claude-test",
    ]);
  });

  test("returns false when execFile rejects (non-timeout)", async () => {
    execFileError = new Error("no server running");
    expect(await realTmuxAdapter.hasSession("missing")).toBe(false);
  });
});

describe("realTmuxAdapter.getPid (#148 review)", () => {
  test("uses execFile and parses pane_pid", async () => {
    execFileStdout = "12345\n";
    expect(await realTmuxAdapter.getPid("claude-test")).toBe(12345);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(execFileCalls[0]?.file).toBe(TMUX_PATH);
    expect(execFileCalls[0]?.args).toEqual([
      ...TMUX_ARGS,
      "list-panes",
      "-t",
      "claude-test",
      "-F",
      "#{pane_pid}",
    ]);
  });
});

/**
 * Issue #222 (carried into #227): every tmux call must be bounded by a timeout
 * and surface a stall via console.warn while keeping expected errors silent.
 *
 * Under #227 the calls are async, but the contract is identical: each method
 * passes a positive `timeout`, degrades to its graceful error path on failure
 * (capturePane → "", hasSession → false, getPid → null, sendKeys → no-op,
 * killSession → swallow, newSession → reject), and logs only on a real timeout.
 */
describe("realTmuxAdapter tmux call timeouts (#222 / #227)", () => {
  function lastTimeout(): number | undefined {
    return execFileCalls[execFileCalls.length - 1]?.opts?.timeout;
  }

  test("newSession passes a positive timeout", async () => {
    await realTmuxAdapter.newSession("claude-test", "echo hi");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("killSession passes a positive timeout", async () => {
    await realTmuxAdapter.killSession("claude-test");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("hasSession passes a positive timeout", async () => {
    await realTmuxAdapter.hasSession("claude-test");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("getPid passes a positive timeout", async () => {
    execFileStdout = "12345\n";
    expect(await realTmuxAdapter.getPid("claude-test")).toBe(12345);
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("capturePane passes a positive timeout", async () => {
    await realTmuxAdapter.capturePane("claude-test");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("sendKeys passes a positive timeout", async () => {
    await realTmuxAdapter.sendKeys("claude-test", ["C-m"]);
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("warns on a timeout so the degradation stays observable (#222)", async () => {
    execFileError = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    // Degrades to the existing error path ("") AND logs the stall.
    expect(await realTmuxAdapter.capturePane("claude-test")).toBe("");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("timed out");
    warnSpy.mockRestore();
  });

  test("does NOT warn for expected non-timeout errors (no pane / no server)", async () => {
    execFileError = new Error("can't find pane: claude-test");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    expect(await realTmuxAdapter.capturePane("claude-test")).toBe("");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

/**
 * Issue #227 (PR-3 / #251) AC-6: the tmux adapter calls must be non-blocking —
 * a tmux call in flight must not freeze the Bun single event loop. We park the
 * mocked execFile callback, then prove a separately scheduled `setTimeout(0)`
 * runs WHILE `hasSession` is awaiting the parked tmux call. A synchronous
 * execFileSync would have run hasSession to completion before any competing
 * timer could interleave — impossible to observe without the async conversion.
 */
describe("realTmuxAdapter is non-blocking (#227 / #251 AC-6)", () => {
  test("hasSession yields the event loop while the tmux call is in flight", async () => {
    const order: string[] = [];
    parkNext = true;

    const pending = realTmuxAdapter.hasSession("claude-park").then((alive) => {
      order.push(`hasSession-resolved:${alive}`);
    });

    // Competing macrotask scheduled after kicking off hasSession.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push("competing");
        resolve();
      }, 0)
    );

    // The tmux call started (recorded), the competing task ran, and hasSession
    // is STILL parked → the loop stayed free during the in-flight tmux call.
    expect(execFileCalls).toHaveLength(1);
    expect(order).toEqual(["competing"]);

    // Release the parked call (success) and confirm hasSession resolves true.
    releasePark();
    await pending;
    expect(order).toEqual(["competing", "hasSession-resolved:true"]);
  });
});
