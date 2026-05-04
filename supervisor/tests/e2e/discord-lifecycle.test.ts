// Discord ↔ Supervisor ↔ tmux lifecycle E2E (Issue #144 Phase 2).
//
// Exercises the full path: InMemoryDiscordClient → wireBotHandlers →
// SessionManager → real tmux (-L claude-hub-test) → claude-mock.sh →
// Stop hook POST → relay-server → InMemoryDiscordClient.sendToThread.
//
// Required env (the test self-skips if missing so dev machines that lack
// tmux or that don't want to spawn real sessions are unaffected):
//   - SUPERVISOR_TMUX_SOCKET=claude-hub-test
//   - SUPERVISOR_CLAUDE_PATH=<absolute path to fixtures/claude-mock.sh>
//
// Phase 3 (#144) wires these into CI.

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
} from "bun:test";
import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "fs";
import { join } from "path";

import { wireBotHandlers } from "../../src/discord/handler";
import { InMemoryDiscordClient } from "../../src/discord/in-memory-client";
import { SessionManager } from "../../src/session/manager";
import { TMUX_PATH, TMUX_ARGS, TMUX_SOCKET } from "../../src/session/tmux";
import { FakeItermAdapter } from "../../src/session/adapters-fake";
import type { ChannelConfig } from "../../src/config/channels";

const TMUX_OP_TIMEOUT = 10_000;
const REQUIRED_SOCKET = "claude-hub-test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, "fixtures/claude-mock.sh");

function tmuxAvailable(): boolean {
  try {
    execFileSync(TMUX_PATH, ["-V"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

const hasTmux = tmuxAvailable();
const correctSocket = TMUX_SOCKET === REQUIRED_SOCKET;
// Compare against `realpath`-resolved values so an env containing a
// symlink or a relative path like "../fixtures/claude-mock.sh" still
// activates the suite when it points at the right script (CodeRabbit
// PR #145 review).
const envClaudePath = process.env.SUPERVISOR_CLAUDE_PATH;
const fixtureExists = existsSync(FIXTURE_PATH);
// Use Node's built-in fs.realpathSync over an external `realpath` binary —
// no subprocess overhead, no PATH/binary dependency, and identical symlink
// resolution semantics on all platforms (gemini PR #146 review).
function realPathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
const correctClaudePath =
  envClaudePath !== undefined &&
  fixtureExists &&
  existsSync(envClaudePath) &&
  realPathOrSelf(envClaudePath) === realPathOrSelf(FIXTURE_PATH);
const enabled = hasTmux && correctSocket && correctClaudePath;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    `[discord-lifecycle.test] skipping (hasTmux=${hasTmux}, ` +
      `socket=${TMUX_SOCKET} required=${REQUIRED_SOCKET}, ` +
      `claudePath=${envClaudePath ?? "<unset>"} required=${FIXTURE_PATH}, ` +
      `fixtureExists=${fixtureExists})`,
  );
}

const itE2E = enabled ? test : test.skip;

let workDir: string;
let projectDir: string;
let manager: SessionManager;
let client: InMemoryDiscordClient;

beforeAll(async () => {
  if (!enabled) return;
  // Project directory the SessionManager will cd into. Real tmux invocation
  // requires it to exist and to be writable for relay-url file storage.
  workDir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  projectDir = join(workDir, "project");
  mkdirSync(projectDir, { recursive: true });
  // Smoke file so any "ls"-style introspection has something to see.
  writeFileSync(join(projectDir, "README.md"), "# lifecycle test fixture\n");

  // Start tmux server on the test socket explicitly so cleanup is symmetric.
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "start-server"], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // new-session will start the server on demand.
  }

  // Real tmux + real relay-server (the bytes flow we want to verify),
  // but a fake iTerm2 adapter so the test doesn't open windows on the
  // dev's machine and so CI Linux runners (no iTerm2) work too.
  manager = new SessionManager({
    effects: { iterm2: new FakeItermAdapter() },
  });
  client = new InMemoryDiscordClient();
  await client.start();

  wireBotHandlers(client, manager, {
    resolveChannel: (name) =>
      name === "lifecycle-test"
        ? ({
            channelName: "lifecycle-test",
            dir: projectDir,
            displayName: "Lifecycle Test",
          } as ChannelConfig)
        : undefined,
    threadIdFor: (cmd) => String(cmd.options.threadId ?? cmd.channelId),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
});

afterAll(async () => {
  if (!enabled) return;
  try {
    await manager.shutdownAll();
  } catch {
    // best-effort; we still want to kill the tmux server.
  }
  if (client.isStarted()) await client.stop();
  // Hard-kill the test tmux server so leftover panes from a flaky run
  // don't poison the next test invocation.
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "kill-server"], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // server already gone
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("Discord lifecycle E2E (Issue #144 Phase 2)", () => {
  itE2E(
    "AC-1: /session start spawns tmux session and replies on the slash channel",
    async () => {
      const threadId = makeThreadId(1);
      try {
        client.injectSlashCommand({
          commandName: "session",
          subcommand: "start",
          options: { channel: "lifecycle-test", threadId },
          channelId: threadId,
        });

        // Wait for the slash reply (handler is async).
        const replies = await waitFor(
          () => {
            const r = client.getSlashReplies();
            return r.length >= 1 ? r : null;
          },
          5_000,
          50,
        );
        expect(replies, "no slash reply within 5s").not.toBeNull();
        expect(replies![0]!.content).toContain("Lifecycle Test");

        // tmux session must exist with the canonical name. Use the public
        // API rather than re-deriving the formula so a future rename surfaces
        // here as a compile error / test fail (gemini PR #145 review).
        const tmuxName = SessionManager.tmuxSessionNameFor(threadId);
        expect(listTmuxSessions()).toContain(tmuxName);

        // Snapshot pane to verify claude-mock.sh launched.
        const pane = capturePane(tmuxName);
        // Pane is up; the mock-claude greeting is timing-dependent so we
        // only assert non-empty bytes here. AC-2 verifies round-trip.
        expect(pane.length).toBeGreaterThan(0);
      } finally {
        await stopIfActive(threadId);
      }
    },
    20_000,
  );

  itE2E(
    "AC-2: thread message round-trips through claude-mock.sh and lands as a sendToThread",
    async () => {
      const threadId = makeThreadId(2);
      try {
        client.injectSlashCommand({
          commandName: "session",
          subcommand: "start",
          options: { channel: "lifecycle-test", threadId },
          channelId: threadId,
        });
        await waitFor(() => (manager.has(threadId) ? true : null), 5_000, 50);

        client.injectThreadMessage({
          threadId,
          content: "ping-from-lifecycle",
        });

        const sent = await waitFor(
          () => {
            const list = client.getSentMessages(threadId);
            return list.length >= 1 ? list : null;
          },
          15_000,
          100,
        );
        expect(sent, "no thread reply within 15s").not.toBeNull();
        // Match on substring rather than full template so claude-mock.sh's
        // greeting prefix can evolve without breaking this AC.
        const matched = sent!.some((m) =>
          m.content.includes("ping-from-lifecycle"),
        );
        expect(matched).toBe(true);
      } finally {
        await stopIfActive(threadId);
      }
    },
    30_000,
  );

  itE2E(
    "AC-3: /session stop tears down the tmux session",
    async () => {
      const threadId = makeThreadId(3);
      // No try/finally — AC-3's purpose IS the stop path; cleanup helper at
      // the end is a no-op when stop already succeeded.
      client.injectSlashCommand({
        commandName: "session",
        subcommand: "start",
        options: { channel: "lifecycle-test", threadId },
        channelId: threadId,
      });
      await waitFor(() => (manager.has(threadId) ? true : null), 5_000, 50);
      const tmuxName = SessionManager.tmuxSessionNameFor(threadId);
      expect(listTmuxSessions()).toContain(tmuxName);

      client.injectSlashCommand({
        commandName: "session",
        subcommand: "stop",
        options: { threadId },
        channelId: threadId,
      });

      await waitFor(() => (!manager.has(threadId) ? true : null), 15_000, 100);
      expect(manager.has(threadId)).toBe(false);

      await waitFor(
        () => (!listTmuxSessions().includes(tmuxName) ? true : null),
        5_000,
        100,
      );
      expect(listTmuxSessions()).not.toContain(tmuxName);
      await stopIfActive(threadId);
    },
    30_000,
  );
});

// ---- helpers ----

function listTmuxSessions(): string[] {
  try {
    return execFileSync(
      TMUX_PATH,
      [...TMUX_ARGS, "list-sessions", "-F", "#{session_name}"],
      { timeout: TMUX_OP_TIMEOUT },
    )
      .toString()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function capturePane(session: string): string {
  try {
    return execFileSync(
      TMUX_PATH,
      [...TMUX_ARGS, "capture-pane", "-p", "-t", session],
      { timeout: TMUX_OP_TIMEOUT },
    ).toString();
  } catch {
    return "";
  }
}

// `T extends NonNullable<unknown>` rules out `null` / `undefined` as valid
// poll results so timeout (returns null) and "polled value happens to be
// null" can never collide.
async function waitFor<T extends NonNullable<unknown>>(
  poll: () => T | null,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = poll();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

function makeThreadId(suffix: number): string {
  return `lifecycle-${process.pid}-${Date.now()}-${suffix}`;
}

async function stopIfActive(threadId: string): Promise<void> {
  if (!manager.has(threadId)) return;
  try {
    await manager.stop(threadId, "manual");
  } catch {
    // afterAll's shutdownAll is the safety net; ignore here.
  }
}
