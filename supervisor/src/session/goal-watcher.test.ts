import { test, expect, describe } from "bun:test";
import { GoalWatcher, DISPATCH_BRANCH_RE } from "./goal-watcher";
import type { SessionInfo, StopReason } from "./types";
import type { SessionManager } from "./manager";
import type { Client } from "discord.js";

// M3 / Issue #262 (corp #52). GoalWatcher is the reaper's sibling: it auto-stops
// a *dispatch-origin* session (branch `corp-dispatch-<N>`) once its Issue carries
// the `done` label, after a grace window that the chairman can cancel by speaking
// in the thread. Verifies spec AC-4 (done→stop), AC-5 (grace cancel), AC-6 (corp
// excluded), AC-7 (Issue close alone ≠ stop). All deps are injected so the unit
// tests never shell out to gh or touch tmux.

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
      // When `cached` is false the thread is absent from the cache (eviction /
      // restart) and only the API fetch resolves it (PR #270 gemini HIGH).
      cache: { get: () => (cached ? channel : undefined) },
      fetch: async () => channel,
    },
  } as unknown as Client;
}

describe("DISPATCH_BRANCH_RE", () => {
  test("captures the Issue number from a dispatch branch", () => {
    expect("corp-dispatch-372".match(DISPATCH_BRANCH_RE)?.[1]).toBe("372");
  });

  test("rejects non-dispatch branches (corp conductor / work branches)", () => {
    expect("52-m1-board-p2".match(DISPATCH_BRANCH_RE)).toBeNull();
    expect("main".match(DISPATCH_BRANCH_RE)).toBeNull();
    expect("corp-dispatch-".match(DISPATCH_BRANCH_RE)).toBeNull();
    expect("corp-dispatch-12a".match(DISPATCH_BRANCH_RE)).toBeNull();
    expect("xcorp-dispatch-1".match(DISPATCH_BRANCH_RE)).toBeNull();
  });
});

describe("GoalWatcher.check", () => {
  test("AC-4: `done` label → after grace window → stop('goal_complete') + archive", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t372", makeSession({ threadId: "t372", branch: "corp-dispatch-372" })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const thread: ThreadStub = {
      name: "🟢 corp-dispatch-372",
      sent: [],
      archived: false,
      renamedTo: null,
    };
    let clock = 1000;
    const watcher = new GoalWatcher(manager, makeClient(thread), {
      fetchIssueLabels: async () => ["done"],
      now: () => clock,
      graceMs: 100,
    });

    // First tick: `done` seen → grace window opens, no stop yet.
    await watcher.check();
    expect(stopCalls).toEqual([]);

    // Within grace: still no stop.
    clock = 1050;
    await watcher.check();
    expect(stopCalls).toEqual([]);

    // Grace elapsed: stop once with goal_complete, thread archived.
    clock = 1101;
    await watcher.check();
    expect(stopCalls).toEqual([{ threadId: "t372", reason: "goal_complete" }]);
    expect(thread.archived).toBe(true);
    expect(thread.renamedTo).not.toBeNull();
    expect(thread.sent.length).toBe(1);
  });

  test("AC-4 (cache miss): an evicted thread is fetched from the API and still archived", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t5", makeSession({ threadId: "t5", branch: "corp-dispatch-5" })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const thread: ThreadStub = {
      name: "🟢 corp-dispatch-5",
      sent: [],
      archived: false,
      renamedTo: null,
    };
    let clock = 0;
    // cached: false → cache.get returns undefined, only channels.fetch resolves it.
    const watcher = new GoalWatcher(manager, makeClient(thread, { cached: false }), {
      fetchIssueLabels: async () => ["done"],
      now: () => clock,
      graceMs: 50,
    });

    await watcher.check(); // open grace
    clock = 100;
    await watcher.check(); // stop + notify via API-fetched thread
    expect(stopCalls).toEqual([{ threadId: "t5", reason: "goal_complete" }]);
    expect(thread.archived).toBe(true);
    expect(thread.sent.length).toBe(1);
  });

  test("AC-5: a thread message during the grace window cancels the stop", async () => {
    const session = makeSession({
      threadId: "t1",
      branch: "corp-dispatch-1",
      lastActivityAt: new Date(5000),
    });
    const sessions = new Map<string, SessionInfo>([["t1", session]]);
    const { manager, stopCalls } = makeManager(sessions);
    let clock = 0;
    const watcher = new GoalWatcher(manager, makeClient(), {
      fetchIssueLabels: async () => ["done"],
      now: () => clock,
      graceMs: 100,
    });

    // Grace opens.
    await watcher.check();
    expect(stopCalls).toEqual([]);

    // Chairman speaks in the thread → lastActivityAt advances past detection.
    session.lastActivityAt = new Date(9000);

    // Grace elapsed, but the activity cancels the auto-stop.
    clock = 1000;
    await watcher.check();
    expect(stopCalls).toEqual([]);
  });

  test("AC-7: Issue without `done` is never stopped, even across the grace window", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t9", makeSession({ threadId: "t9", branch: "corp-dispatch-9" })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    let clock = 0;
    const watcher = new GoalWatcher(manager, makeClient(), {
      // A merged/closed Issue still only carries phase labels — never `done`.
      fetchIssueLabels: async () => ["staging-ready", "deployed"],
      now: () => clock,
      graceMs: 100,
    });

    await watcher.check();
    clock = 1000;
    await watcher.check();
    clock = 2000;
    await watcher.check();
    expect(stopCalls).toEqual([]);
  });

  test("AC-6: corp conductor (branchless) and work-branch sessions are excluded", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["corp", makeSession({ threadId: "corp", branch: undefined })],
      ["work", makeSession({ threadId: "work", branch: "52-m1-board-p2" })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    let fetchCalls = 0;
    let clock = 0;
    const watcher = new GoalWatcher(manager, makeClient(), {
      fetchIssueLabels: async () => {
        fetchCalls++;
        return ["done"];
      },
      now: () => clock,
      graceMs: 100,
    });

    await watcher.check();
    clock = 1000;
    await watcher.check();
    expect(stopCalls).toEqual([]);
    // Non-dispatch branches must never even trigger a label lookup.
    expect(fetchCalls).toBe(0);
  });

  test("fail-soft: a label-fetch error never throws and never stops a live session", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t1", makeSession({ threadId: "t1", branch: "corp-dispatch-1" })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const watcher = new GoalWatcher(manager, makeClient(), {
      fetchIssueLabels: async () => {
        throw new Error("gh rate limited");
      },
      graceMs: 0,
    });

    await watcher.check(); // must resolve, not reject
    expect(stopCalls).toEqual([]);
  });

  test("stops only once: a removed session is not re-stopped on the next tick", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t1", makeSession({ threadId: "t1", branch: "corp-dispatch-1" })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    let clock = 0;
    const watcher = new GoalWatcher(manager, makeClient(), {
      fetchIssueLabels: async () => ["done"],
      now: () => clock,
      graceMs: 50,
    });

    await watcher.check(); // open grace
    clock = 100;
    await watcher.check(); // stop (session removed by manager.stop)
    clock = 200;
    await watcher.check(); // session gone → nothing more
    expect(stopCalls).toEqual([{ threadId: "t1", reason: "goal_complete" }]);
  });
});
