// Supervisor ↔ tmux session lifecycle E2E (Issue #144 / #273).
//
// Drives the real SessionManager lifecycle against real tmux:
//   SessionManager.start → real tmux (-L claude-hub-test) → claude-mock.sh
//   → Stop-hook POST → relay-server → SessionManager.sendMessage result
//   → SessionManager.stop tears the tmux session down.
//
// This closes the gap the existing CI E2E (tests/e2e/ac-verification.test.ts)
// does NOT cover: ac-verification exercises the raw tmux/relay *primitives*
// directly, but never drives SessionManager's own start/relay/stop lifecycle.
// We test SessionManager directly (not via the Discord-routing layer) so the
// suite has no dependency on bot.ts / slash wiring — that glue stays covered by
// unit tests. See PR #146 (closed) rationale on why the wireBotHandlers duplicate
// was dropped.
//
// Required env (the suite self-skips when missing so dev machines without tmux,
// or that don't want to spawn real sessions, are unaffected):
//   - SUPERVISOR_TMUX_SOCKET=claude-hub-test   (isolates from prod `claude-hub`)
//   - SUPERVISOR_CLAUDE_PATH=<abs path to fixtures/claude-mock.sh>
// CI (.github/workflows/ci.yml, e2e job) injects both.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { resolve, dirname, join } from "path";
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

// Resolve both sides through realpath so a SUPERVISOR_CLAUDE_PATH that is a
// symlink or a relative path still activates the suite when it points at the
// right fixture (CodeRabbit PR #145 review).
function realPathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const hasTmux = tmuxAvailable();
const correctSocket = TMUX_SOCKET === REQUIRED_SOCKET;
const envClaudePath = process.env.SUPERVISOR_CLAUDE_PATH;
const fixtureExists = existsSync(FIXTURE_PATH);
const correctClaudePath =
  envClaudePath !== undefined &&
  fixtureExists &&
  existsSync(envClaudePath) &&
  realPathOrSelf(envClaudePath) === realPathOrSelf(FIXTURE_PATH);
const enabled = hasTmux && correctSocket && correctClaudePath;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    `[session-lifecycle.test] skipping (hasTmux=${hasTmux}, ` +
      `socket=${TMUX_SOCKET} required=${REQUIRED_SOCKET}, ` +
      `claudePath=${envClaudePath ?? "<unset>"} required=${FIXTURE_PATH}, ` +
      `fixtureExists=${fixtureExists})`,
  );
}

const itE2E = enabled ? test : test.skip;

let workDir: string;
let projectDir: string;
let manager: SessionManager;
let config: ChannelConfig;

beforeAll(async () => {
  if (!enabled) return;
  // Project directory the SessionManager cd's into. Real tmux invocation needs
  // it to exist and be writable for the relay-url file.
  workDir = mkdtempSync(join(tmpdir(), "session-lifecycle-"));
  projectDir = join(workDir, "project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# session lifecycle fixture\n");

  // Start the tmux server on the test socket explicitly so cleanup is symmetric.
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "start-server"], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // new-session will start the server on demand.
  }

  // Real tmux + real relay-server (the byte flow under test) but a fake iTerm2
  // adapter so no windows open on the dev's machine and CI Linux runners work.
  manager = new SessionManager({
    effects: { iterm2: new FakeItermAdapter() },
  });
  config = {
    channelName: "session-lifecycle-test",
    dir: projectDir,
    displayName: "Session Lifecycle Test",
  };
});

afterAll(async () => {
  if (!enabled) return;
  try {
    // Guard: beforeAll may have thrown before `manager` was assigned (e.g. the
    // SessionManager constructor failing), leaving it undefined here (gemini
    // PR #274 review). shutdownAll is still best-effort; the tmux kill below runs
    // regardless so a half-initialised run can't leak the test server.
    if (manager) await manager.shutdownAll();
  } catch {
    // best-effort; still kill the tmux server below.
  }
  // Hard-kill the test tmux server so leftover panes from a flaky run don't
  // poison the next invocation. Scoped to the test socket only (RW-019).
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

describe("Supervisor session lifecycle E2E (Issue #144 / #273)", () => {
  itE2E(
    "AC-1: SessionManager.start spawns a live tmux session under the canonical name",
    async () => {
      const threadId = makeThreadId(1);
      try {
        await manager.start(config, threadId);

        expect(manager.has(threadId)).toBe(true);

        // Use the public API rather than re-deriving the formula so a future
        // rename surfaces here as a test failure (gemini PR #145 review).
        const tmuxName = SessionManager.tmuxSessionNameFor(threadId);
        expect(listTmuxSessions()).toContain(tmuxName);

        // Pane is up; the mock-claude greeting is timing-dependent so we only
        // assert non-empty bytes here. AC-2 verifies the relay round-trip.
        expect(capturePane(tmuxName).length).toBeGreaterThan(0);
      } finally {
        await stopIfActive(threadId);
      }
    },
    20_000,
  );

  itE2E(
    "AC-2: sendMessage round-trips through claude-mock.sh and the relay server",
    async () => {
      const threadId = makeThreadId(2);
      try {
        await manager.start(config, threadId);

        const result = await manager.sendMessage(threadId, "ping-from-lifecycle");

        expect(result.error, `relay error: ${result.error ?? ""}`).toBeFalsy();
        // Match on substring rather than the full mock template so claude-mock.sh's
        // greeting prefix can evolve without breaking this AC.
        const echoed =
          (result.text ?? "").includes("ping-from-lifecycle") ||
          result.chunks.some((c) => c.includes("ping-from-lifecycle"));
        expect(echoed, `no round-trip echo in ${JSON.stringify(result)}`).toBe(
          true,
        );
      } finally {
        await stopIfActive(threadId);
      }
    },
    30_000,
  );

  itE2E(
    "AC-3: SessionManager.stop tears the tmux session down",
    async () => {
      const threadId = makeThreadId(3);
      // No try/finally — AC-3's purpose IS the stop path; the cleanup helper at
      // the end is a no-op once stop has already succeeded.
      await manager.start(config, threadId);
      const tmuxName = SessionManager.tmuxSessionNameFor(threadId);
      expect(listTmuxSessions()).toContain(tmuxName);

      await manager.stop(threadId, "manual");
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

// `T extends NonNullable<unknown>` rules out null/undefined as valid poll
// results so a timeout (returns null) can never collide with a polled null.
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
