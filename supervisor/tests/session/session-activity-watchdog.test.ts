import { test, expect, describe, spyOn } from "bun:test";
import {
  classifyActivity,
  buildActivityWarning,
  createActivityTracker,
  longLivedBand,
  getActivityThresholds,
  ActivityWatchdog,
  type ActivityThresholds,
  type ActivityWarning,
} from "../../src/session/session-activity-watchdog";

const MIN = 60_000;
const HOUR = 60 * MIN;

// Explicit thresholds keep logic tests deterministic regardless of env.
const T: ActivityThresholds = {
  quietMs: 60 * MIN, // 60 min
  longLivedMs: 6 * HOUR, // 6 h
};

describe("classifyActivity (Journey AC #3: no false positives)", () => {
  test("returns null when neither quiet nor long-lived", () => {
    expect(classifyActivity({ ageMs: 30 * MIN, idleMs: 10 * MIN }, T)).toBeNull();
    expect(classifyActivity({ ageMs: 0, idleMs: 0 }, T)).toBeNull();
    // exactly one tick below each threshold
    expect(
      classifyActivity({ ageMs: 6 * HOUR - 1, idleMs: 60 * MIN - 1 }, T)
    ).toBeNull();
  });

  test("flags quiet at/above the quiet threshold (AC1)", () => {
    expect(classifyActivity({ ageMs: 70 * MIN, idleMs: 60 * MIN }, T)).toBe(
      "quiet"
    );
  });

  test("flags long_lived at/above the long-lived threshold (AC3)", () => {
    expect(classifyActivity({ ageMs: 6 * HOUR, idleMs: 5 * MIN }, T)).toBe(
      "long_lived"
    );
  });

  test("long_lived takes precedence when both apply", () => {
    expect(classifyActivity({ ageMs: 21 * HOUR, idleMs: 2 * HOUR }, T)).toBe(
      "long_lived"
    );
  });

  test("non-finite samples are treated as no signal (defensive)", () => {
    // ageMs/idleMs are now-minus-Date; an Invalid Date yields NaN. We treat any
    // non-finite value as "no signal" (matching context-budget.ts) so a corrupt
    // timestamp can never produce a spurious alert. Infinity cannot occur in
    // practice (both operands are real ms) but is covered for completeness.
    expect(classifyActivity({ ageMs: NaN, idleMs: NaN }, T)).toBeNull();
    expect(classifyActivity({ ageMs: Infinity, idleMs: 0 }, T)).toBeNull();
    expect(classifyActivity({ ageMs: 0, idleMs: Infinity }, T)).toBeNull();
  });
});

describe("buildActivityWarning", () => {
  test("long_lived cites #209, shows ⏳ and the elapsed duration", () => {
    const msg = buildActivityWarning(
      "long_lived",
      { ageMs: 6 * HOUR, idleMs: 5 * MIN },
      T
    );
    expect(msg).toContain("⏳");
    expect(msg).toContain("6時間");
    expect(msg).toContain("#209");
  });

  test("quiet cites #209, shows ⚠️ and the idle duration", () => {
    const msg = buildActivityWarning(
      "quiet",
      { ageMs: 90 * MIN, idleMs: 75 * MIN },
      T
    );
    expect(msg).toContain("⚠️");
    expect(msg).toContain("1時間15分");
    expect(msg).toContain("#209");
  });

  test("formats sub-hour durations in minutes", () => {
    const msg = buildActivityWarning(
      "quiet",
      { ageMs: 90 * MIN, idleMs: 45 * MIN },
      T
    );
    expect(msg).toContain("45分");
  });
});

describe("longLivedBand (#221 escalating re-arm)", () => {
  test("returns 0 below the long-lived threshold", () => {
    expect(longLivedBand(5 * HOUR, 6 * HOUR)).toBe(0);
    expect(longLivedBand(6 * HOUR - 1, 6 * HOUR)).toBe(0);
  });

  test("band increases at each doubling of the threshold", () => {
    expect(longLivedBand(6 * HOUR, 6 * HOUR)).toBe(1); // 1x
    expect(longLivedBand(11 * HOUR, 6 * HOUR)).toBe(1); // <2x stays band 1
    expect(longLivedBand(12 * HOUR, 6 * HOUR)).toBe(2); // 2x
    expect(longLivedBand(24 * HOUR, 6 * HOUR)).toBe(3); // 4x
    expect(longLivedBand(48 * HOUR, 6 * HOUR)).toBe(4); // 8x
  });

  test("non-finite age or non-positive threshold -> 0 (defensive)", () => {
    expect(longLivedBand(NaN, 6 * HOUR)).toBe(0);
    expect(longLivedBand(Infinity, 6 * HOUR)).toBe(0);
    expect(longLivedBand(10 * HOUR, 0)).toBe(0);
  });
});

describe("createActivityTracker (de-dup, Journey AC #1/#3)", () => {
  test("long_lived de-dups within a band but re-fires at each new age band (#221)", () => {
    const tr = createActivityTracker(T);
    const w = tr.check({ ageMs: 6 * HOUR, idleMs: 1 * MIN });
    expect(w).not.toBeNull();
    expect(w!.level).toBe("long_lived");
    // same band (6h..<12h) -> de-dup
    expect(tr.check({ ageMs: 7 * HOUR, idleMs: 1 * MIN })).toBeNull();
    expect(tr.check({ ageMs: 11 * HOUR, idleMs: 1 * MIN })).toBeNull();
    // next band at 12h (2x) -> re-fires (#221: no longer silent for life)
    expect(tr.check({ ageMs: 12 * HOUR, idleMs: 1 * MIN })!.level).toBe(
      "long_lived"
    );
    // next band at 24h (4x) -> re-fires again
    expect(tr.check({ ageMs: 24 * HOUR, idleMs: 1 * MIN })!.level).toBe(
      "long_lived"
    );
    // same band (24h..<48h) -> de-dup
    expect(tr.check({ ageMs: 30 * HOUR, idleMs: 1 * MIN })).toBeNull();
  });

  test("quiet warns once per episode and re-arms after activity resumes (AC1)", () => {
    const tr = createActivityTracker(T);
    // becomes quiet
    expect(tr.check({ ageMs: 90 * MIN, idleMs: 60 * MIN })!.level).toBe("quiet");
    // still quiet -> no spam
    expect(tr.check({ ageMs: 100 * MIN, idleMs: 70 * MIN })).toBeNull();
    // activity resumes (idle below threshold) -> episode resets
    expect(tr.check({ ageMs: 110 * MIN, idleMs: 2 * MIN })).toBeNull();
    // goes quiet again -> warns again
    expect(tr.check({ ageMs: 180 * MIN, idleMs: 60 * MIN })!.level).toBe(
      "quiet"
    );
  });

  test("never warns for a healthy active session (no false positive)", () => {
    const tr = createActivityTracker(T);
    expect(tr.check({ ageMs: 30 * MIN, idleMs: 1 * MIN })).toBeNull();
    expect(tr.check({ ageMs: 2 * HOUR, idleMs: 5 * MIN })).toBeNull();
  });

  test("long_lived (one-shot) and quiet (episode) are tracked independently", () => {
    const tr = createActivityTracker(T);
    // quiet first (age below long-lived)
    expect(tr.check({ ageMs: 2 * HOUR, idleMs: 60 * MIN })!.level).toBe("quiet");
    // now also long-lived while still quiet -> long_lived fires (priority, not yet warned)
    expect(tr.check({ ageMs: 6 * HOUR, idleMs: 90 * MIN })!.level).toBe(
      "long_lived"
    );
    // both already warned -> silent
    expect(tr.check({ ageMs: 7 * HOUR, idleMs: 120 * MIN })).toBeNull();
  });

  test("long_lived firing while quiet suppresses the immediately-redundant quiet follow-up", () => {
    const tr = createActivityTracker(T);
    // first observation is already both long-lived AND quiet -> long_lived wins
    expect(tr.check({ ageMs: 6 * HOUR, idleMs: 90 * MIN })!.level).toBe(
      "long_lived"
    );
    // next tick still long-lived + quiet -> NOT a second (quiet) alert
    expect(tr.check({ ageMs: 7 * HOUR, idleMs: 120 * MIN })).toBeNull();
  });

  test("a quiet episode that begins AFTER a long_lived alert still fires (not suppressed forever)", () => {
    const tr = createActivityTracker(T);
    // long-lived fires while the session is active (idle small) -> not quiet
    expect(tr.check({ ageMs: 6 * HOUR, idleMs: 2 * MIN })!.level).toBe(
      "long_lived"
    );
    // session keeps running, still active -> silent
    expect(tr.check({ ageMs: 8 * HOUR, idleMs: 5 * MIN })).toBeNull();
    // now it falls silent -> a quiet alert is still warranted
    expect(tr.check({ ageMs: 10 * HOUR, idleMs: 70 * MIN })!.level).toBe(
      "quiet"
    );
  });
});

describe("getActivityThresholds env override", () => {
  test("defaults to 60min quiet / 6h long-lived", () => {
    const prevQ = process.env.SESSION_QUIET_WARN_MS;
    const prevL = process.env.SESSION_LONG_LIVED_WARN_MS;
    delete process.env.SESSION_QUIET_WARN_MS;
    delete process.env.SESSION_LONG_LIVED_WARN_MS;
    try {
      expect(getActivityThresholds()).toEqual({
        quietMs: 60 * MIN,
        longLivedMs: 6 * HOUR,
      });
    } finally {
      if (prevQ !== undefined) process.env.SESSION_QUIET_WARN_MS = prevQ;
      if (prevL !== undefined) process.env.SESSION_LONG_LIVED_WARN_MS = prevL;
    }
  });

  test("honours env overrides", () => {
    const prev = process.env.SESSION_QUIET_WARN_MS;
    process.env.SESSION_QUIET_WARN_MS = "120000";
    try {
      expect(getActivityThresholds().quietMs).toBe(120_000);
    } finally {
      if (prev === undefined) delete process.env.SESSION_QUIET_WARN_MS;
      else process.env.SESSION_QUIET_WARN_MS = prev;
    }
  });
});

describe("ActivityWatchdog.check (periodic scan)", () => {
  type FakeSession = { startedAt: Date; lastActivityAt: Date };

  function makeDeps(opts: {
    sessions: Map<string, FakeSession>;
    alive: Set<string>;
    nowRef: { t: number };
  }) {
    const notifications: Array<{ threadId: string; warning: ActivityWarning }> =
      [];
    const wd = new ActivityWatchdog({
      entries: () => opts.sessions.entries(),
      isAlive: (id) => opts.alive.has(id),
      notify: (threadId, warning) => {
        notifications.push({ threadId, warning });
      },
      thresholds: T,
      now: () => opts.nowRef.t,
    });
    return { wd, notifications };
  }

  test("warns a long-lived alive session exactly once across ticks (AC3)", async () => {
    const start = 0;
    const sessions = new Map<string, FakeSession>([
      [
        "thread-a",
        { startedAt: new Date(start), lastActivityAt: new Date(start) },
      ],
    ]);
    const nowRef = { t: 0 };
    const { wd, notifications } = makeDeps({
      sessions,
      alive: new Set(["thread-a"]),
      nowRef,
    });

    // The session stays active (lastActivityAt tracks now) so the *quiet*
    // signal never fires — this isolates the long_lived (AC3) one-shot. This is
    // the #209 shape: ran 21h while the owner kept messaging it.
    // tick 1 at +5h: not yet long-lived, recent activity -> no warn
    nowRef.t = 5 * HOUR;
    sessions.get("thread-a")!.lastActivityAt = new Date(nowRef.t);
    await wd.check();
    expect(notifications).toHaveLength(0);

    // tick 2 at +6h: long-lived (age 6h), still active -> warn once
    nowRef.t = 6 * HOUR;
    sessions.get("thread-a")!.lastActivityAt = new Date(nowRef.t);
    await wd.check();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.threadId).toBe("thread-a");
    expect(notifications[0]!.warning.level).toBe("long_lived");

    // tick 3 at +8h: still long-lived but already warned -> no new warn
    nowRef.t = 8 * HOUR;
    sessions.get("thread-a")!.lastActivityAt = new Date(nowRef.t);
    await wd.check();
    expect(notifications).toHaveLength(1);
  });

  test("skips dead sessions (left to the reaper)", async () => {
    const sessions = new Map<string, FakeSession>([
      ["dead-1", { startedAt: new Date(0), lastActivityAt: new Date(0) }],
    ]);
    const nowRef = { t: 24 * HOUR };
    const { wd, notifications } = makeDeps({
      sessions,
      alive: new Set(), // dead-1 is not alive
      nowRef,
    });
    await wd.check();
    expect(notifications).toHaveLength(0);
  });

  test("does not warn a healthy active session (no false positive)", async () => {
    const nowRef = { t: 2 * HOUR };
    const sessions = new Map<string, FakeSession>([
      [
        "busy",
        {
          startedAt: new Date(0),
          lastActivityAt: new Date(2 * HOUR - 1 * MIN),
        },
      ],
    ]);
    const { wd, notifications } = makeDeps({
      sessions,
      alive: new Set(["busy"]),
      nowRef,
    });
    await wd.check();
    expect(notifications).toHaveLength(0);
  });

  test("GCs tracker state for sessions that disappeared (re-warns on a new session reusing the id)", async () => {
    const nowRef = { t: 6 * HOUR };
    const sessions = new Map<string, FakeSession>([
      ["t1", { startedAt: new Date(0), lastActivityAt: new Date(0) }],
    ]);
    const { wd, notifications } = makeDeps({
      sessions,
      alive: new Set(["t1"]),
      nowRef,
    });
    // warns long-lived once
    await wd.check();
    expect(notifications).toHaveLength(1);

    // session t1 ends and is removed
    sessions.delete("t1");
    await wd.check(); // GCs t1 tracker

    // a brand-new session reuses thread id t1, already old -> warns again
    sessions.set("t1", {
      startedAt: new Date(nowRef.t - 6 * HOUR),
      lastActivityAt: new Date(nowRef.t),
    });
    await wd.check();
    expect(notifications).toHaveLength(2);
  });

  test("an isAlive() rejection skips that session and does not abort the scan (#405)", async () => {
    const nowRef = { t: 7 * HOUR };
    const sessions = new Map<string, FakeSession>([
      ["boom", { startedAt: new Date(0), lastActivityAt: new Date(0) }],
      ["ok", { startedAt: new Date(0), lastActivityAt: new Date(0) }],
    ]);
    const notified: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const wd = new ActivityWatchdog({
      entries: () => sessions.entries(),
      isAlive: async (id) => {
        if (id === "boom") throw new Error("tmux unreachable");
        return true;
      },
      notify: (threadId) => {
        notified.push(threadId);
      },
      thresholds: T,
      now: () => nowRef.t,
    });
    try {
      await wd.check();
      // "boom" is skipped (liveness unknown → stay quiet, the reaper owns it)
      // but the scan continues to "ok".
      expect(notified).toEqual(["ok"]);
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0]![0])).toContain("isAlive(boom) threw");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("awaits an async isAlive (the real sessionManager.livenessOf shape, #227 PR-3)", async () => {
    const nowRef = { t: 7 * HOUR };
    const sessions = new Map<string, FakeSession>([
      ["a", { startedAt: new Date(0), lastActivityAt: new Date(0) }],
    ]);
    const notified: string[] = [];
    const wd = new ActivityWatchdog({
      entries: () => sessions.entries(),
      // Resolves on a later microtask: a non-awaiting implementation would see
      // a truthy Promise for a DEAD session and warn about it.
      isAlive: async () => {
        await Promise.resolve();
        return false;
      },
      notify: (threadId) => {
        notified.push(threadId);
      },
      thresholds: T,
      now: () => nowRef.t,
    });
    await wd.check();
    expect(notified).toHaveLength(0);
  });

  test("a notify() failure does not abort the scan of other sessions", async () => {
    const nowRef = { t: 7 * HOUR };
    const sessions = new Map<string, FakeSession>([
      ["boom", { startedAt: new Date(0), lastActivityAt: new Date(0) }],
      ["ok", { startedAt: new Date(0), lastActivityAt: new Date(0) }],
    ]);
    const seen: string[] = [];
    const wd = new ActivityWatchdog({
      entries: () => sessions.entries(),
      isAlive: () => true,
      notify: (threadId) => {
        seen.push(threadId);
        if (threadId === "boom") throw new Error("discord down");
      },
      thresholds: T,
      now: () => nowRef.t,
    });
    await wd.check();
    // both were visited despite the first throwing
    expect(seen).toContain("boom");
    expect(seen).toContain("ok");
  });
});

describe("ActivityWatchdog timer lifecycle (#405)", () => {
  type FakeSession = { startedAt: Date; lastActivityAt: Date };

  function makeWatchdog(intervalMs: number) {
    const sessions = new Map<string, FakeSession>();
    let scans = 0;
    const wd = new ActivityWatchdog({
      // entries() is called exactly once per check() pass, so it is an exact
      // tick counter — no wall-clock assumption beyond "a tick happened".
      entries: () => {
        scans++;
        return sessions.entries();
      },
      isAlive: () => true,
      notify: () => {},
      thresholds: T,
      intervalMs,
      now: () => 0,
    });
    return { wd, scans: () => scans };
  }

  test("start() drives check() on the configured interval and stop() halts it", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const { wd, scans } = makeWatchdog(5);
    try {
      wd.start();
      expect(String(logSpy.mock.calls[0]![0])).toContain(
        "[ActivityWatchdog] Started"
      );

      const deadline = Date.now() + 2000;
      while (scans() < 2 && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(scans()).toBeGreaterThanOrEqual(2);

      wd.stop();
      const afterStop = scans();
      await Bun.sleep(40); // >= 8 intervals: a live timer would tick again
      expect(scans()).toBe(afterStop);
    } finally {
      wd.stop();
      logSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  test("start() is idempotent — a second call does not add a second timer", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const { wd, scans } = makeWatchdog(10);
    try {
      wd.start();
      wd.start(); // early-returns; the log line is the observable proof
      expect(logSpy).toHaveBeenCalledTimes(1);

      const deadline = Date.now() + 2000;
      while (scans() < 1 && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      wd.stop();
      const afterStop = scans();
      // A leaked second interval would keep ticking after the single stop().
      await Bun.sleep(50);
      expect(scans()).toBe(afterStop);
    } finally {
      wd.stop();
      logSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  test("stop() is safe before start() and idempotent", () => {
    const { wd } = makeWatchdog(10);
    expect(() => wd.stop()).not.toThrow();
    expect(() => wd.stop()).not.toThrow();
  });

  test("the interval is unref'd so a running watchdog never holds the process open", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const { wd } = makeWatchdog(60_000);
    try {
      wd.start();
      // White-box on purpose: "does not keep the event loop alive" has no
      // black-box assertion short of hanging the suite. hasRef() is the direct
      // read of the flag start() sets.
      const timer = (wd as unknown as { timer: { hasRef(): boolean } }).timer;
      expect(timer.hasRef()).toBe(false);
    } finally {
      wd.stop();
      logSpy.mockRestore();
    }
  });
});

/**
 * Issue #416: a session waiting on an unanswered AskUserQuestion is quiet by
 * design — the question is already in the thread and the user is the one being
 * waited on. Nudging "silent for N minutes" on top of it is noise competing
 * with the question itself.
 */
describe("ActivityWatchdog — sessions awaiting an AskUserQuestion answer", () => {
  type FakeSession = { startedAt: Date; lastActivityAt: Date };

  test("skips the nudge while awaiting an answer, and warns once the ask resolves", async () => {
    const nowRef = { t: 0 };
    const sessions = new Map<string, FakeSession>([
      ["asking", { startedAt: new Date(0), lastActivityAt: new Date(0) }],
    ]);
    const notifications: Array<{ threadId: string; warning: ActivityWarning }> = [];
    let awaiting = true;
    const wd = new ActivityWatchdog({
      entries: () => sessions.entries(),
      isAlive: () => true,
      isAwaitingAsk: () => awaiting,
      notify: (threadId, warning) => {
        notifications.push({ threadId, warning });
      },
      thresholds: T,
      now: () => nowRef.t,
    });

    nowRef.t = T.quietMs + 1;
    await wd.check();
    expect(notifications).toEqual([]);

    // The warning was skipped, not consumed: once the question is answered and
    // the session is STILL silent, the nudge it would have got now fires.
    awaiting = false;
    nowRef.t = T.quietMs + 2;
    await wd.check();
    expect(notifications.map((n) => n.warning.level)).toEqual(["quiet"]);
  });
});
