import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
} from "bun:test";

/**
 * Issue #147 regression test: realTmuxAdapter.newSession must pass `command`
 * to tmux as a single argv element, so any shell metacharacters inside
 * (single quotes, $-expansions, brace expansion seeds) survive intact until
 * tmux's own /bin/sh -c invocation inside the new session.
 *
 * Pre-fix: `execSync(\`tmux new-session ... '${command}'\`)` re-parsed
 * `command` through the calling shell. A command containing
 * `--mcp-config '{"mcpServers":{}}'` would have its outer single quote
 * pair closed by the inner one, leaking the JSON into bash word-splitting
 * and bricking the claude session immediately on spawn.
 *
 * Post-fix: `execFileSync(TMUX_PATH, [..., name, command])` bypasses the
 * shell entirely, so `command` is one argv element verbatim.
 */

let execFileCalls: Array<{ file: string; args: readonly string[] }> = [];
const mockExecFileSync = mock(
  (file: unknown, args: unknown): Buffer => {
    execFileCalls.push({
      file: file as string,
      args: args as readonly string[],
    });
    return Buffer.from("");
  }
);

// execSync is still used by killSession/hasSession/getPid; keep it mockable
// so tests don't accidentally shell out.
const mockExecSync = mock((..._args: unknown[]) => "");

// We re-export the rest of node:child_process untouched so other modules
// loaded in this test process (e.g. anything importing `spawn`) keep working.
const realChildProcess = await import("child_process");
mock.module("child_process", () => ({
  ...realChildProcess,
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
}));

const { realTmuxAdapter } = await import("../../src/session/adapters");
const { TMUX_PATH, TMUX_ARGS } = await import("../../src/session/tmux");

beforeEach(() => {
  execFileCalls = [];
  mockExecFileSync.mockClear();
  mockExecSync.mockClear();
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
