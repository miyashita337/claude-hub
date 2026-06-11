import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
} from "bun:test";

/**
 * Issue #147 regression tests: every realTmuxAdapter method must reach tmux
 * via execFileSync + argv array so neither `command` nor `name` flow through
 * the calling shell.
 *
 * Pre-fix: `execSync(\`tmux new-session ... '${command}'\`)` re-parsed
 * `command` through the calling shell. A command containing
 * `--mcp-config '{"mcpServers":{}}'` would have its outer single quote
 * pair closed by the inner one, leaking the JSON into bash word-splitting
 * and bricking the claude session immediately on spawn (#147).
 *
 * killSession / hasSession / getPid also accepted `name` via string
 * interpolation. PR #148 review (gemini critical) flagged that pattern as
 * a latent shell-injection vector even though current callers pass numeric
 * thread-IDs — defence-in-depth, not a current exploit.
 *
 * Post-fix: every method uses execFileSync(TMUX_PATH, [..., name, ...])
 * so user input cannot reach the shell at all.
 */

let execFileCalls: Array<{ file: string; args: readonly string[] }> = [];
// PR #148 review (gemini medium): mock signature typed directly to avoid
// `unknown` + type assertion in the body.
const mockExecFileSync = mock(
  (file: string, args: readonly string[]): Buffer => {
    execFileCalls.push({ file, args });
    return Buffer.from("");
  }
);

// We re-export the rest of node:child_process untouched so other modules
// loaded in this test process (e.g. anything importing `spawn`) keep working.
const realChildProcess = await import("child_process");
mock.module("child_process", () => ({
  ...realChildProcess,
  execFileSync: mockExecFileSync,
}));

const { realTmuxAdapter } = await import("../../src/session/adapters");
const { TMUX_PATH, TMUX_ARGS } = await import("../../src/session/tmux");

beforeEach(() => {
  execFileCalls = [];
  mockExecFileSync.mockClear();
});

describe("realTmuxAdapter.newSession (#147)", () => {
  test("uses execFileSync with argv array (no shell parsing)", () => {
    realTmuxAdapter.newSession("claude-test", "echo hi");

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
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

  test("preserves single quotes in command (the #147 regression)", () => {
    // This is the exact pattern that broke Supervisor in #104:
    // --mcp-config '{"mcpServers":{}}' embedded in a longer chain.
    const command =
      `cd /tmp && exec claude --mcp-config '{"mcpServers":{}}'`;

    realTmuxAdapter.newSession("claude-x", command);

    // The command must appear in argv VERBATIM — no quote balancing,
    // no escape-mangling, no truncation at the inner single quote.
    expect(execFileCalls[0]?.args.at(-1)).toBe(command);
  });

  test("preserves $-expansions, backticks, and brace seeds", () => {
    // None of these should expand client-side. tmux is responsible for
    // running /bin/sh -c on this string inside the new session.
    const tricky =
      `export X=$HOME && echo \`date\` && touch {a,b,c}.txt && exec claude`;

    realTmuxAdapter.newSession("claude-tricky", tricky);

    expect(execFileCalls[0]?.args.at(-1)).toBe(tricky);
  });
});

describe("realTmuxAdapter.killSession (#148 review)", () => {
  test("uses execFileSync with name as argv element (no shell)", () => {
    realTmuxAdapter.killSession("claude-test");

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(execFileCalls[0]?.file).toBe(TMUX_PATH);
    expect(execFileCalls[0]?.args).toEqual([
      ...TMUX_ARGS,
      "kill-session",
      "-t",
      "claude-test",
    ]);
  });

  test("neutralises shell-metacharacter injection via name", () => {
    // The gemini review example. With the old execSync template literal
    // this would have run `reboot` on the host. argv array passing makes
    // the whole string a single argument to tmux's -t flag.
    const malicious = `x"; reboot; #`;

    realTmuxAdapter.killSession(malicious);

    expect(execFileCalls[0]?.args.at(-1)).toBe(malicious);
  });
});

describe("realTmuxAdapter.hasSession (#148 review)", () => {
  test("returns true when execFileSync succeeds", () => {
    expect(realTmuxAdapter.hasSession("claude-test")).toBe(true);
    expect(execFileCalls[0]?.args).toEqual([
      ...TMUX_ARGS,
      "has-session",
      "-t",
      "claude-test",
    ]);
  });

  test("returns false when execFileSync throws", () => {
    const throwingMock = mock(
      (_file: string, _args: readonly string[]): Buffer => {
        throw new Error("no server running");
      }
    );
    mock.module("child_process", () => ({
      ...realChildProcess,
      execFileSync: throwingMock,
    }));

    // Re-import so the adapter picks up the throwing mock for this test
    // only; the mock.module call above is scoped to this test's lifetime.
    return import("../../src/session/adapters").then(({ realTmuxAdapter: a }) => {
      expect(a.hasSession("missing")).toBe(false);

      // Restore the normal non-throwing mock for subsequent tests.
      mock.module("child_process", () => ({
        ...realChildProcess,
        execFileSync: mockExecFileSync,
      }));
    });
  });
});

describe("realTmuxAdapter.getPid (#148 review)", () => {
  test("uses execFileSync and parses pane_pid", () => {
    const pidMock = mock(
      (_file: string, _args: readonly string[]): string => "12345\n"
    );
    mock.module("child_process", () => ({
      ...realChildProcess,
      execFileSync: pidMock,
    }));

    return import("../../src/session/adapters").then(({ realTmuxAdapter: a }) => {
      expect(a.getPid("claude-test")).toBe(12345);
      expect(pidMock).toHaveBeenCalledTimes(1);
      const [file, args] = pidMock.mock.calls[0] ?? [];
      expect(file).toBe(TMUX_PATH);
      expect(args).toEqual([
        ...TMUX_ARGS,
        "list-panes",
        "-t",
        "claude-test",
        "-F",
        "#{pane_pid}",
      ]);

      // Restore normal mock for the rest of the file.
      mock.module("child_process", () => ({
        ...realChildProcess,
        execFileSync: mockExecFileSync,
      }));
    });
  });
});

/**
 * Issue #222: every synchronous tmux call must be bounded by a timeout.
 *
 * A wedged tmux server (capture-pane / send-keys ETIMEDOUT stalls that grow
 * over Supervisor uptime) was blocking these `execFileSync` calls — and with
 * them the Node event loop — for unbounded time, starving relay HTTP response
 * handling. That surfaced as delayed / 5-min-timed-out Discord delivery rather
 * than hard failures. Bounding each call converts an indefinite hang into the
 * method's existing graceful error path (capturePane → "", hasSession → false,
 * getPid → null, sendKeys → no-op, killSession → swallow, newSession → throw).
 */
describe("realTmuxAdapter tmux call timeouts (#222)", () => {
  beforeEach(() => {
    // Guard against earlier tests that swapped the child_process mock: make
    // sure the call-recording mockExecFileSync is the active impl here.
    mock.module("child_process", () => ({
      ...realChildProcess,
      execFileSync: mockExecFileSync,
    }));
  });

  function lastTimeout(): number | undefined {
    // The mock is declared with a 2-arg signature, but Bun records every actual
    // argument — read the 3rd (options) positionally via an unknown[] view.
    const calls = mockExecFileSync.mock.calls as ReadonlyArray<readonly unknown[]>;
    const opts = calls[calls.length - 1]?.[2] as { timeout?: number } | undefined;
    return opts?.timeout;
  }

  test("newSession passes a positive timeout", () => {
    realTmuxAdapter.newSession("claude-test", "echo hi");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("killSession passes a positive timeout", () => {
    realTmuxAdapter.killSession("claude-test");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("hasSession passes a positive timeout", () => {
    realTmuxAdapter.hasSession("claude-test");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("getPid passes a positive timeout", () => {
    realTmuxAdapter.getPid("claude-test");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("capturePane passes a positive timeout", () => {
    realTmuxAdapter.capturePane("claude-test");
    expect(lastTimeout()).toBeGreaterThan(0);
  });

  test("sendKeys passes a positive timeout", () => {
    realTmuxAdapter.sendKeys("claude-test", ["C-m"]);
    expect(lastTimeout()).toBeGreaterThan(0);
  });
});
