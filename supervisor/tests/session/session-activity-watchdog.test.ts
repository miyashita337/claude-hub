import { test, expect, describe } from "bun:test";
import {
  classifyActivity,
  buildActivityWarning,
  createActivityTracker,
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

describe("createActivityTracker (de-dup, Journey AC #1/#3)", () => {
  test("long_lived warns once, then de-dups on later ticks (AC3 one-shot)", () => {
    const tr = createActivityTracker(T);
    const w = tr.check({ ageMs: 6 * HOUR, idleMs: 1 * MIN });
    expect(w).not.toBeNull();
    expect(w!.level).toBe("long_lived");
    // later ticks (even older) do not re-warn
    expect(tr.check({ ageMs: 7 * HOUR, idleMs: 1 * MIN })).toBeNull();
    expect(tr.check({ ageMs: 24 * HOUR, idleMs: 1 * MIN })).toBeNull();
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
