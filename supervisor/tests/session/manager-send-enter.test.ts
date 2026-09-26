import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// Isolate DB writes from the real sessions.db (mirrors manager-input-ready.test.ts).
process.env.SUPERVISOR_DB_PATH = ":memory:";

const { SessionManager } = await import("../../src/session/manager");
const { createFakeEffects } = await import("../../src/session/adapters-fake");
import type { FakeSessionEffects } from "../../src/session/adapters-fake";

/**
 * Issue #357 AC-2 (journey): when a relayed message sits un-submitted in the
 * TUI input box, the user must be able to submit it from Discord alone
 * (`/session enter`) instead of attaching a terminal. `sendEnter` is the manager
 * half: a bare Enter to THIS thread's pane, and a clear throw when there is no
 * pane to send it to (so the command never reports a success it did not have).
 */

const THREAD_ID = "thread-enter-357";
// Mirrors SessionManager.tmuxSessionName: `claude-` + threadId.slice(0, 12).
const tmuxName = `claude-${THREAD_ID.slice(0, 12)}`;

function registerSession(
  manager: InstanceType<typeof SessionManager>,
  threadId: string
): void {
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(threadId, {
    id: "sess-enter",
    threadId,
    lastActivityAt: new Date(0),
  });
}

describe("SessionManager.sendEnter (#357)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;

  beforeEach(() => {
    effects = createFakeEffects();
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0 });
  });

  afterEach(async () => {
    await manager?.shutdownAll();
  });

  test("sends exactly one bare Enter to this thread's pane", async () => {
    await effects.tmux.newSession(tmuxName, "claude ...");
    registerSession(manager, THREAD_ID);

    await manager.sendEnter(THREAD_ID);

    expect(effects.tmux.sendKeysCalls).toEqual([{ name: tmuxName, keys: ["C-m"] }]);
  });

  test("throws (sending nothing) when the thread has no session", async () => {
    await expect(manager.sendEnter("thread-unknown")).rejects.toThrow();
    expect(effects.tmux.sendKeysCalls).toHaveLength(0);
  });

  test("throws (sending nothing) when the tmux pane is gone", async () => {
    registerSession(manager, THREAD_ID);
    await expect(manager.sendEnter(THREAD_ID)).rejects.toThrow("tmux session dead");
    expect(effects.tmux.sendKeysCalls).toHaveLength(0);
  });
});
