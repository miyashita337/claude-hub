import { test, expect, describe } from "bun:test";
import {
  OrphanDispatchReaper,
  selectReapableDispatch,
  ORPHAN_REAP_REASON,
} from "./orphan-dispatch-reaper";
import type { SessionInfo, StopReason } from "./types";
import type { SessionManager } from "./manager";
import type { Client } from "discord.js";

// Issue #275 (option B). OrphanDispatchReaper is GoalWatcher's sibling for the
// *not-done, long-idle* case: it stops a dispatch-origin session (branch
// `corp-dispatch-<N>`) whose spawning corp CEO session exited but which never
// reached `done`, before the 30-day idle reaper would. Verifies the journey ACs:
// AC1 (orphans don't silently pile up — they are stopped + a notice is posted),
// AC2 (done-未達 かつ 長期idle stopped; 作業中 = active sessions spared). All deps
// are injected so the unit tests never shell out or touch tmux.

const HOUR = 60 * 60 * 1000;
const IDLE_THRESHOLD = 48 * HOUR;

function makeSession(
  over: Partial<SessionInfo> & { threadId: string }
): SessionInfo {
  const now = new Date();
  return {
    id: over.threadId,
    channelName: "convert-service",
    projectDir: "/repo/.claude/worktrees/corp-dispatch-1",
    pid: 1,
    process: null as unknown as SessionInfo["process"],
    startedAt: now,
    lastActivityAt: now,
    status: "running",
    ...over,
  } as SessionInfo;
}

interface StopCall {
  threadId: string;
  reason: StopReason;
}

function makeManager(sessions: Map<string, SessionInfo>): {
  manager: SessionManager;
  stopCalls: StopCall[];
} {
  const stopCalls: StopCall[] = [];
  const manager = {
    entries: () => sessions.entries(),
    stop: async (threadId: string, reason: StopReason) => {
      stopCalls.push({ threadId, reason });
      // Mirror the real stop(): the session leaves the live map.
      sessions.delete(threadId);
    },
  } as unknown as SessionManager;
  return { manager, stopCalls };
}

interface ThreadStub {
  name: string;
  sent: string[];
  archived: boolean;
  renamedTo: string | null;
}

function makeClient(
  thread?: ThreadStub,
  opts: { cached?: boolean } = {}
): Client {
  const cached = opts.cached ?? true;
  const channel = thread
    ? {
        isThread: () => true,
        get name() {
          return thread.name;
        },
        send: async (msg: string) => {
          thread.sent.push(msg);
        },
        setName: async (n: string) => {
          thread.renamedTo = n;
          thread.name = n;
        },
        setArchived: async (v: boolean) => {
          thread.archived = v;
        },
      }
    : undefined;
  return {
    channels: {
      cache: { get: () => (cached ? channel : undefined) },
      fetch: async () => channel,
    },
  } as unknown as Client;
}

/** A session whose last activity was `hoursAgo` before `now`. */
function idleSession(
  threadId: string,
  branch: string | undefined,
  hoursAgo: number,
  now: number,
  status: SessionInfo["status"] = "running"
): SessionInfo {
  return makeSession({
    threadId,
    branch,
    status,
    lastActivityAt: new Date(now - hoursAgo * HOUR),
  });
}

describe("selectReapableDispatch", () => {
  const now = 1_000_000_000_000;
  const opts = { idleThresholdMs: IDLE_THRESHOLD, now };

  test("AC2: a not-done dispatch session idle past the threshold is selected", () => {
    const entries = new Map<string, SessionInfo>([
      ["t42", idleSession("t42", "corp-dispatch-42", 50, now)],
    ]);
    const got = selectReapableDispatch(entries.entries(), opts);
    expect(got.map((c) => c.threadId)).toEqual(["t42"]);
    expect(got[0]!.idleMs).toBe(50 * HOUR);
  });

  test("AC2: an active dispatch session (idle < threshold) is spared (作業中は巻き込まれない)", () => {
    const entries = new Map<string, SessionInfo>([
      ["t42", idleSession("t42", "corp-dispatch-42", 10, now)],
    ]);
    expect(selectReapableDispatch(entries.entries(), opts)).toEqual([]);
  });

  test("boundary: idle exactly at the threshold is selected (>=)", () => {
    const entries = new Map<string, SessionInfo>([
      ["t1", idleSession("t1", "corp-dispatch-1", 48, now)],
    ]);
    expect(selectReapableDispatch(entries.entries(), opts).map((c) => c.threadId)).toEqual([
      "t1",
    ]);
  });

  test("non-dispatch branches (conductor / work / main / none) are never selected", () => {
    const entries = new Map<string, SessionInfo>([
      ["conductor", idleSession("conductor", "52-m1-board", 100, now)],
      ["main", idleSession("main", "main", 100, now)],
      ["nobranch", idleSession("nobranch", undefined, 100, now)],
      ["almost", idleSession("almost", "corp-dispatch-", 100, now)],
      ["trailing", idleSession("trailing", "corp-dispatch-12a", 100, now)],
    ]);
    expect(selectReapableDispatch(entries.entries(), opts)).toEqual([]);
  });

  test("a session already `stopping` is skipped (no double-stop)", () => {
    const entries = new Map<string, SessionInfo>([
      ["t9", idleSession("t9", "corp-dispatch-9", 100, now, "stopping")],
    ]);
    expect(selectReapableDispatch(entries.entries(), opts)).toEqual([]);
  });

  test("mixed fleet: only the idle dispatch orphans are selected", () => {
    const entries = new Map<string, SessionInfo>([
      ["orphan1", idleSession("orphan1", "corp-dispatch-100", 72, now)],
      ["active", idleSession("active", "corp-dispatch-101", 1, now)],
      ["human", idleSession("human", "feature-x", 200, now)],
      ["orphan2", idleSession("orphan2", "corp-dispatch-102", 49, now)],
    ]);
    const got = selectReapableDispatch(entries.entries(), opts).map((c) => c.threadId);
    expect(got.sort()).toEqual(["orphan1", "orphan2"]);
  });
});

describe("OrphanDispatchReaper.check", () => {
  const now = 2_000_000_000_000;

  test("AC1/AC2: idle dispatch orphan → stop('orphan_reaped') + notice + rename + archive", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t42", idleSession("t42", "corp-dispatch-42", 50, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const thread: ThreadStub = {
      name: "🟢 corp-dispatch-42",
      sent: [],
      archived: false,
      renamedTo: null,
    };
    const reaper = new OrphanDispatchReaper(manager, makeClient(thread), {
      now: () => now,
      idleThresholdMs: IDLE_THRESHOLD,
    });

    await reaper.check();

    expect(stopCalls).toEqual([{ threadId: "t42", reason: "orphan_reaped" }]);
    expect(ORPHAN_REAP_REASON).toBe("orphan_reaped");
    expect(thread.archived).toBe(true);
    expect(thread.renamedTo).not.toBeNull();
    expect(thread.sent.length).toBe(1);
    expect(thread.sent[0]).toContain("#275");
  });

  test("AC2: an active dispatch session is left running (not stopped)", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t42", idleSession("t42", "corp-dispatch-42", 5, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const reaper = new OrphanDispatchReaper(manager, makeClient(), {
      now: () => now,
      idleThresholdMs: IDLE_THRESHOLD,
    });

    await reaper.check();
    expect(stopCalls).toEqual([]);
    expect(sessions.has("t42")).toBe(true);
  });

  test("a non-dispatch idle session is not touched", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["human", idleSession("human", "feature-x", 500, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const reaper = new OrphanDispatchReaper(manager, makeClient(), {
      now: () => now,
      idleThresholdMs: IDLE_THRESHOLD,
    });

    await reaper.check();
    expect(stopCalls).toEqual([]);
    expect(sessions.has("human")).toBe(true);
  });

  test("cache miss: an evicted thread is fetched from the API and still archived", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t5", idleSession("t5", "corp-dispatch-5", 60, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const thread: ThreadStub = {
      name: "🟢 corp-dispatch-5",
      sent: [],
      archived: false,
      renamedTo: null,
    };
    const reaper = new OrphanDispatchReaper(
      manager,
      makeClient(thread, { cached: false }),
      { now: () => now, idleThresholdMs: IDLE_THRESHOLD }
    );

    await reaper.check();
    expect(stopCalls).toEqual([{ threadId: "t5", reason: "orphan_reaped" }]);
    expect(thread.archived).toBe(true);
  });

  test("per-session error isolation: one failing stop does not abort the others", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["bad", idleSession("bad", "corp-dispatch-1", 60, now)],
      ["good", idleSession("good", "corp-dispatch-2", 60, now)],
    ]);
    const stopCalls: StopCall[] = [];
    const manager = {
      entries: () => sessions.entries(),
      stop: async (threadId: string, reason: StopReason) => {
        if (threadId === "bad") throw new Error("boom");
        stopCalls.push({ threadId, reason });
        sessions.delete(threadId);
      },
    } as unknown as SessionManager;

    const reaper = new OrphanDispatchReaper(manager, makeClient(), {
      now: () => now,
      idleThresholdMs: IDLE_THRESHOLD,
    });

    await reaper.check();
    // "good" is still reaped despite "bad" throwing.
    expect(stopCalls).toEqual([{ threadId: "good", reason: "orphan_reaped" }]);
  });

  test("idempotent: a second tick after reaping is a no-op (session already gone)", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t42", idleSession("t42", "corp-dispatch-42", 60, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const reaper = new OrphanDispatchReaper(manager, makeClient(), {
      now: () => now,
      idleThresholdMs: IDLE_THRESHOLD,
    });

    await reaper.check();
    await reaper.check();
    expect(stopCalls.length).toBe(1);
  });
});
