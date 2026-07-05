import { test, expect, describe } from "bun:test";
import {
  DispatchHealthReaper,
  HEALTH_REAP_REASON,
} from "./dispatch-health-reaper";
import type { BusyProbeResult } from "./dispatch-child-probe";
import type { SessionInfo, StopReason } from "./types";
import type { SessionManager } from "./manager";
import type { Client } from "discord.js";

// Issue #279. DispatchHealthReaper escalates ActivityWatchdog's *nudge* to
// *auto-reap* for dispatch sessions (branch `corp-dispatch-<N>`) that have been
// silent past the health horizon AND have no live CI/build/test/push child
// process. It reuses selectReapableDispatch (the orphan reaper's pure selector)
// for candidate selection, then layers the child-process probe as the mis-fire
// guard the orphan reaper lacks. All deps (clock, probe, Discord) are injected —
// the tests never shell out. Covers the journey ACs: AC1 (silent + idle → reap +
// report), AC2 (silent + busy child → spared), AC3 (silence clock survives a
// restart because selection is lastActivityAt-based, not startedAt-based).

const HOUR = 60 * 60 * 1000;
const SILENCE = 2 * HOUR;

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

function makeClient(thread?: ThreadStub): Client {
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
      cache: { get: () => channel },
      fetch: async () => channel,
    },
  } as unknown as Client;
}

function silentSession(
  threadId: string,
  branch: string | undefined,
  hoursSilent: number,
  now: number,
  extra: Partial<SessionInfo> = {}
): SessionInfo {
  return makeSession({
    threadId,
    branch,
    lastActivityAt: new Date(now - hoursSilent * HOUR),
    ...extra,
  });
}

/** A probe that returns a fixed verdict and records which threads it saw. */
function fixedProbe(
  result: BusyProbeResult | ((threadId: string) => BusyProbeResult)
): { probe: (threadId: string) => Promise<BusyProbeResult>; calls: string[] } {
  const calls: string[] = [];
  const probe = async (threadId: string) => {
    calls.push(threadId);
    return typeof result === "function" ? result(threadId) : result;
  };
  return { probe, calls };
}

describe("DispatchHealthReaper.check — the silence × child-process quadrants", () => {
  const now = 3_000_000_000_000;

  test("AC1: silent past horizon + probe idle → stop(health_reaped) + report + rename + archive", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t7", silentSession("t7", "corp-dispatch-7", 3, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const thread: ThreadStub = {
      name: "🟢 corp-dispatch-7",
      sent: [],
      archived: false,
      renamedTo: null,
    };
    const { probe, calls } = fixedProbe("idle");
    const reaper = new DispatchHealthReaper(manager, makeClient(thread), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();

    expect(stopCalls).toEqual([{ threadId: "t7", reason: "health_reaped" }]);
    expect(HEALTH_REAP_REASON).toBe("health_reaped");
    expect(calls).toEqual(["t7"]);
    expect(thread.archived).toBe(true);
    expect(thread.renamedTo).not.toBeNull();
    expect(thread.sent.length).toBe(1);
    expect(thread.sent[0]).toContain("#279");
  });

  test("AC2: silent past horizon but probe busy (CI running) → spared, stays running", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t7", silentSession("t7", "corp-dispatch-7", 5, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const { probe, calls } = fixedProbe("busy");
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();

    expect(stopCalls).toEqual([]);
    expect(sessions.has("t7")).toBe(true);
    expect(calls).toEqual(["t7"]); // probe WAS consulted for a candidate
  });

  test("fail-safe: probe unknown (pane/table unreadable) → NOT reaped", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t7", silentSession("t7", "corp-dispatch-7", 5, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const { probe } = fixedProbe("unknown");
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    expect(stopCalls).toEqual([]);
    expect(sessions.has("t7")).toBe(true);
  });

  test("fail-safe: a probe that throws → NOT reaped (spared), other sessions unaffected", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["boom", silentSession("boom", "corp-dispatch-1", 5, now)],
      ["ok", silentSession("ok", "corp-dispatch-2", 5, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const probe = async (threadId: string): Promise<BusyProbeResult> => {
      if (threadId === "boom") throw new Error("probe blew up");
      return "idle";
    };
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    // "boom" spared (probe threw → fail-safe); "ok" still reaped.
    expect(stopCalls).toEqual([{ threadId: "ok", reason: "health_reaped" }]);
    expect(sessions.has("boom")).toBe(true);
  });

  test("active dispatch session (silent < horizon) is never a candidate — probe not even called", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t7", silentSession("t7", "corp-dispatch-7", 1, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const { probe, calls } = fixedProbe("idle");
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    expect(stopCalls).toEqual([]);
    expect(calls).toEqual([]); // no wasteful probe on a healthy session
  });

  test("non-dispatch idle session (human / conductor / main) is left alone — probe not called", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["human", silentSession("human", "feature-x", 100, now)],
      ["main", silentSession("main", "main", 100, now)],
      ["cond", silentSession("cond", "52-m1-board", 100, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const { probe, calls } = fixedProbe("idle");
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    expect(stopCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("AC3: silence clock survives a supervisor restart (selection is lastActivityAt-based, not startedAt)", async () => {
    // Simulate a restart: the process just came up (startedAt = now) but the
    // session's lastActivityAt was restored from SQLite to 3h ago. A startedAt-
    // based timer would reset to 0 and never reap; lastActivityAt-based selection
    // correctly sees 3h of silence and reaps.
    const sessions = new Map<string, SessionInfo>([
      [
        "t7",
        silentSession("t7", "corp-dispatch-7", 3, now, {
          startedAt: new Date(now), // freshly restarted
        }),
      ],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const { probe } = fixedProbe("idle");
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    expect(stopCalls).toEqual([{ threadId: "t7", reason: "health_reaped" }]);
  });

  test("boundary: silence exactly at the horizon is reaped (>=)", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t7", silentSession("t7", "corp-dispatch-7", 2, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const { probe } = fixedProbe("idle");
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });
    await reaper.check();
    expect(stopCalls).toEqual([{ threadId: "t7", reason: "health_reaped" }]);
  });

  test("mixed fleet: only silent+idle dispatch orphans are reaped", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["reap", silentSession("reap", "corp-dispatch-100", 4, now)], // idle → reap
      ["busy", silentSession("busy", "corp-dispatch-101", 4, now)], // busy → spare
      ["active", silentSession("active", "corp-dispatch-102", 1, now)], // fresh → spare
      ["human", silentSession("human", "feature-x", 99, now)], // non-dispatch
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const probe = async (t: string): Promise<BusyProbeResult> =>
      t === "busy" ? "busy" : "idle";
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    expect(stopCalls).toEqual([{ threadId: "reap", reason: "health_reaped" }]);
    expect(sessions.has("busy")).toBe(true);
    expect(sessions.has("active")).toBe(true);
    expect(sessions.has("human")).toBe(true);
  });

  test("per-session isolation: one failing stop does not abort the others", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["bad", silentSession("bad", "corp-dispatch-1", 4, now)],
      ["good", silentSession("good", "corp-dispatch-2", 4, now)],
    ]);
    const stopCalls: StopCall[] = [];
    const manager = {
      entries: () => sessions.entries(),
      stop: async (threadId: string, reason: StopReason) => {
        if (threadId === "bad") throw new Error("stop boom");
        stopCalls.push({ threadId, reason });
        sessions.delete(threadId);
      },
    } as unknown as SessionManager;
    const { probe } = fixedProbe("idle");
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    expect(stopCalls).toEqual([{ threadId: "good", reason: "health_reaped" }]);
  });

  test("idempotent: a second tick after reaping is a no-op", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t7", silentSession("t7", "corp-dispatch-7", 4, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const { probe } = fixedProbe("idle");
    const reaper = new DispatchHealthReaper(manager, makeClient(), {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    await reaper.check();
    expect(stopCalls.length).toBe(1);
  });

  test("cache miss: an evicted thread is fetched from the API and still reported", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t7", silentSession("t7", "corp-dispatch-7", 4, now)],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const thread: ThreadStub = {
      name: "🟢 corp-dispatch-7",
      sent: [],
      archived: false,
      renamedTo: null,
    };
    // client whose cache misses but fetch resolves the thread.
    const client = {
      channels: {
        cache: { get: () => undefined },
        fetch: async () => ({
          isThread: () => true,
          get name() {
            return thread.name;
          },
          send: async (m: string) => {
            thread.sent.push(m);
          },
          setName: async (n: string) => {
            thread.renamedTo = n;
            thread.name = n;
          },
          setArchived: async (v: boolean) => {
            thread.archived = v;
          },
        }),
      },
    } as unknown as Client;
    const { probe } = fixedProbe("idle");
    const reaper = new DispatchHealthReaper(manager, client, {
      now: () => now,
      silenceThresholdMs: SILENCE,
      probe,
    });

    await reaper.check();
    expect(stopCalls).toEqual([{ threadId: "t7", reason: "health_reaped" }]);
    expect(thread.archived).toBe(true);
    expect(thread.sent.length).toBe(1);
  });
});
