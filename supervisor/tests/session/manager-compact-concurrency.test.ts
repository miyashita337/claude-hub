import { test, expect, describe, beforeEach } from "bun:test";

// Isolate DB writes from the real sessions.db (mirrors manager-input-ready.test.ts).
process.env.SUPERVISOR_DB_PATH = ":memory:";

const { SessionManager, CompactInFlightError } = await import(
  "../../src/session/manager"
);
const { createFakeEffects } = await import("../../src/session/adapters-fake");
import type { FakeSessionEffects } from "../../src/session/adapters-fake";

/**
 * Overlapping-compact guard (Issue #364).
 *
 * `compactSession` relays `/compact` as a multi-step send-keys sequence
 * (Escape → literal → Enter). Two overlapping calls interleave into the SAME
 * pane and can strand a partial command in the TUI. A slash command is hard to
 * fire twice in the same instant; a *button* stays clickable after the click,
 * so the double-click made this race reachable.
 *
 * The seam is `effects.tmux.hasSession`: it is the first await inside the guard,
 * so parking there holds the claim open deterministically. (`sendToPane` is a
 * module-level function against real tmux, not an injected effect, so it always
 * fails here — which is what makes it a usable "did the claim get released?"
 * probe below.)
 */

const THREAD_ID = "thread-compact-race";
// Mirrors SessionManager.tmuxSessionName: `claude-` + threadId.slice(0, 12).
const tmuxName = `claude-${THREAD_ID.slice(0, 12)}`;

function registerSession(
  manager: InstanceType<typeof SessionManager>,
  threadId: string,
  id: string
): void {
  // compactSession only needs the map hit plus a live tmux verdict.
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    threadId,
    { id, threadId, lastActivityAt: new Date() }
  );
}

describe("SessionManager.compactSession overlapping guard (#364)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;

  beforeEach(async () => {
    effects = createFakeEffects();
    manager = new SessionManager({ effects });
    await effects.tmux.newSession(tmuxName, "x");
    registerSession(manager, THREAD_ID, "sess-race");
  });

  test("a second compact while one is in flight is rejected, not interleaved", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realHasSession = effects.tmux.hasSession.bind(effects.tmux);
    let calls = 0;
    effects.tmux.hasSession = async (name: string) => {
      calls++;
      if (calls === 1) await gate; // hold the first compact inside the guard
      return realHasSession(name);
    };

    const first = manager.compactSession(THREAD_ID, "意図A").catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    await expect(manager.compactSession(THREAD_ID, "意図B")).rejects.toThrow(
      CompactInFlightError
    );
    // The rejected call must not have reached the pane at all.
    expect(calls).toBe(1);

    release!();
    await first;
  });

  test("the claim is released after the call settles (no permanent block)", async () => {
    // sendToPane targets real tmux, which has no pane for this fake session, so
    // both calls fail there. What matters is HOW the second one fails: anything
    // other than CompactInFlightError proves the first claim was released.
    await manager.compactSession(THREAD_ID, "意図A").catch(() => {});
    const second = manager.compactSession(THREAD_ID, "意図B").catch((e) => e);

    expect(await second).not.toBeInstanceOf(CompactInFlightError);
  });

  test("a failure before the send also releases the claim", async () => {
    await effects.tmux.killSession(tmuxName);
    await expect(manager.compactSession(THREAD_ID, "意図A")).rejects.toThrow(
      "tmux session dead"
    );

    // A dead pane must not leave the thread permanently blocked.
    const second = await manager
      .compactSession(THREAD_ID, "意図B")
      .catch((e) => e);
    expect(second).not.toBeInstanceOf(CompactInFlightError);
  });

  test("the guard is per-thread, not global", async () => {
    // Must differ within the FIRST 12 chars: tmuxSessionName truncates there,
    // so "thread-compact-other" would collide with THREAD_ID's pane name.
    const otherThread = "second-thread-xyz";
    await effects.tmux.newSession(`claude-${otherThread.slice(0, 12)}`, "x");
    registerSession(manager, otherThread, "sess-other");

    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realHasSession = effects.tmux.hasSession.bind(effects.tmux);
    effects.tmux.hasSession = async (name: string) => {
      if (name === tmuxName) await gate;
      return realHasSession(name);
    };

    const first = manager.compactSession(THREAD_ID, "意図A").catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    // A different thread is unaffected by the first thread's in-flight compact.
    const other = await manager
      .compactSession(otherThread, "意図B")
      .catch((e) => e);
    expect(other).not.toBeInstanceOf(CompactInFlightError);

    release!();
    await first;
  });
});
