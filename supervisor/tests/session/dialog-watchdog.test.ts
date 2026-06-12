import { test, expect, describe } from "bun:test";
import {
  startDialogWatchdog,
  nextPollInterval,
  type WatchdogTimerHandle,
} from "../../src/session/dialog-watchdog";
import type { DialogMatch } from "../../src/session/dialog-detect";

/**
 * Watchdog unit tests with fake capture / sendKeys. No tmux required.
 *
 * Issue #57 / Phase D-3: verify the auto-accept → heartbeat escalation path.
 *
 * Issue #190: these tests previously drove the watchdog at a 10ms real tick
 * and used `await setTimeout(...)` to "wait N ticks". That made them
 * non-deterministic — under CI/dev-machine load a tick could miss its
 * window and an expected auto-accept/heartbeat would not have fired by the
 * time the test asserted (base branch flaked ~1/5). We now inject a VIRTUAL
 * CLOCK so ticks run in deterministic virtual time: `clock.advance(ms)` runs
 * exactly the callbacks whose scheduled time falls within the window, in time
 * order, awaiting each tick to completion (including the reschedule in the
 * tick's `finally`). No wall-clock involved → zero timing flake.
 */

const SHORT_TICK_MS = 10;

interface ScheduledTimer {
  at: number;
  seq: number;
  cb: () => Promise<void>;
  cancelled: boolean;
}

/**
 * Deterministic virtual clock. Models `setTimeout`/`clearTimeout` over a
 * virtual timeline: `setTimer(cb, ms)` enqueues `cb` at `now + ms`;
 * `advance(ms)` runs all due (non-cancelled) callbacks in time order until the
 * virtual clock reaches `now + ms`. Because each tick reschedules itself in
 * its `finally`, a single `advance` drives the recursive poll loop exactly as
 * real timers would — but with no real time elapsing, so the result is
 * identical on a fast laptop and a loaded CI runner.
 *
 * Crucially the clock RESPECTS each timer's delay, so a watchdog that backs
 * off (longer interval) fires fewer times than a base-interval one in the same
 * virtual window — the property the #222 backoff test asserts.
 */
function createVirtualClock() {
  let now = 0;
  let seq = 0;
  let handleSeq = 0;
  // Map handle -> entry so clearTimer can cancel in place.
  const byHandle = new Map<number, ScheduledTimer>();
  const queue: ScheduledTimer[] = [];

  const setTimer = (
    cb: () => Promise<void>,
    delayMs: number
  ): WatchdogTimerHandle => {
    const handle = ++handleSeq;
    const entry: ScheduledTimer = {
      at: now + delayMs,
      seq: ++seq,
      cb,
      cancelled: false,
    };
    queue.push(entry);
    byHandle.set(handle, entry);
    return handle;
  };

  const clearTimer = (handle: WatchdogTimerHandle): void => {
    const entry = byHandle.get(handle as number);
    if (entry) {
      entry.cancelled = true;
      byHandle.delete(handle as number);
    }
  };

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      // Find the earliest non-cancelled callback due at or before `target`,
      // tie-broken by insertion order (FIFO at equal timestamps).
      let next: ScheduledTimer | null = null;
      let nextIdx = -1;
      for (let i = 0; i < queue.length; i++) {
        const e = queue[i]!;
        if (e.cancelled || e.at > target) continue;
        if (
          next === null ||
          e.at < next.at ||
          (e.at === next.at && e.seq < next.seq)
        ) {
          next = e;
          nextIdx = i;
        }
      }
      if (next === null) break;
      queue.splice(nextIdx, 1);
      now = next.at;
      // Run the tick to completion; its `finally` enqueues the next timer at
      // the (now-advanced) virtual time, which the loop will pick up if due.
      await next.cb();
    }
    now = target;
  };

  return { setTimer, clearTimer, advance };
}

describe("dialog-watchdog", () => {
  test("does not call onAutoAccept when pane is clean", async () => {
    const clock = createVirtualClock();
    const accepts: DialogMatch[] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-clean",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => "no dialog here\nnormal output\n",
      sendKeys: () => {},
      onAutoAccept: (m) => accepts.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.advance(SHORT_TICK_MS * 4);
    watchdog.stop();
    expect(accepts.length).toBe(0);
  });

  test("auto-accepts ink-confirm with C-m", async () => {
    const clock = createVirtualClock();
    const accepts: DialogMatch[] = [];
    const sentKeys: { session: string; keys: string[] }[] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-ink",
      pollIntervalMs: SHORT_TICK_MS,
      maxAutoAcceptAttempts: 2,
      capture: () => "Permission required\n  ❯ Yes\n    No\n",
      sendKeys: (session, keys) => {
        sentKeys.push({ session, keys });
      },
      onAutoAccept: (m) => accepts.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.advance(SHORT_TICK_MS * 3);
    watchdog.stop();
    expect(accepts.length).toBeGreaterThanOrEqual(1);
    expect(accepts[0]!.kind).toBe("ink-confirm");
    expect(sentKeys[0]!.session).toBe("test-ink");
    expect(sentKeys[0]!.keys).toEqual(["C-m"]);
  });

  test("auto-accepts bash-yn with y + Enter", async () => {
    const clock = createVirtualClock();
    const sentKeys: string[][] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-bash",
      pollIntervalMs: SHORT_TICK_MS,
      maxAutoAcceptAttempts: 1,
      capture: () => "rm dangerous\nDo you want to proceed? (y/N)\n",
      sendKeys: (_, keys) => sentKeys.push(keys),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.advance(SHORT_TICK_MS * 3);
    watchdog.stop();
    expect(sentKeys.length).toBeGreaterThanOrEqual(1);
    expect(sentKeys[0]).toEqual(["y", "C-m"]);
  });

  // Issue #153: the feedback survey must be dismissed with `0`, NEVER `1`
  // (option 1 submits "Bad" feedback). This locks the survey wiring against
  // future regressions.
  test("auto-dismisses feedback-survey with 0 + Enter (never 1)", async () => {
    const clock = createVirtualClock();
    const sentKeys: string[][] = [];
    const accepts: DialogMatch[] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-survey",
      pollIntervalMs: SHORT_TICK_MS,
      maxAutoAcceptAttempts: 1,
      capture: () =>
        "● How is Claude doing this session? (optional)\n  1: Bad    2: Fine   3: Good   0: Dismiss\n",
      sendKeys: (_, keys) => sentKeys.push(keys),
      onAutoAccept: (m) => accepts.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    // finally-guard stop() so a thrown assertion can't leak the poll timer.
    try {
      await clock.advance(SHORT_TICK_MS * 3);
    } finally {
      watchdog.stop();
    }
    expect(accepts.length).toBeGreaterThanOrEqual(1);
    expect(accepts[0]!.kind).toBe("feedback-survey");
    expect(sentKeys[0]).toEqual(["0", "C-m"]);
    // Defensive: the survey must never auto-press 1 (= "Bad" feedback).
    expect(sentKeys.some((k) => k[0] === "1")).toBe(false);
  });

  test("escalates to onHeartbeat after auto-accept budget exhausted", async () => {
    const clock = createVirtualClock();
    const heartbeats: DialogMatch[] = [];
    const acceptsFired: DialogMatch[] = [];
    // Simulate a stuck dialog: pane never clears, watchdog tries 2 times
    // then fires heartbeat exactly once.
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-stuck",
      pollIntervalMs: SHORT_TICK_MS,
      maxAutoAcceptAttempts: 2,
      capture: () => "Stuck dialog\n  ❯ Yes\n    No\n",
      sendKeys: () => {
        // never clears — pane content stays the same
      },
      onAutoAccept: (m) => acceptsFired.push(m),
      onHeartbeat: (m) => {
        heartbeats.push(m);
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    // Need at least maxAutoAcceptAttempts + 1 ticks for heartbeat to fire.
    await clock.advance(SHORT_TICK_MS * 6);
    watchdog.stop();

    expect(acceptsFired.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats.length).toBe(1);
    expect(heartbeats[0]!.kind).toBe("ink-confirm");
  });

  test("heartbeat only fires once per dialog instance", async () => {
    const clock = createVirtualClock();
    const heartbeats: DialogMatch[] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-once",
      pollIntervalMs: SHORT_TICK_MS,
      maxAutoAcceptAttempts: 1,
      capture: () => "  ❯ Yes\n    No\n",
      sendKeys: () => {},
      onHeartbeat: (m) => {
        heartbeats.push(m);
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    // Run for many ticks — heartbeat should still fire only once.
    await clock.advance(SHORT_TICK_MS * 10);
    watchdog.stop();
    expect(heartbeats.length).toBe(1);
  });

  test("resets heartbeat state after dialog clears", async () => {
    const clock = createVirtualClock();
    const heartbeats: DialogMatch[] = [];
    let phase: "stuck" | "clean" | "stuck2" = "stuck";
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-reset",
      pollIntervalMs: SHORT_TICK_MS,
      maxAutoAcceptAttempts: 1,
      capture: () => {
        if (phase === "stuck" || phase === "stuck2")
          return "  ❯ Yes\n    No\n";
        return "all clear\n";
      },
      sendKeys: () => {},
      onHeartbeat: (m) => {
        heartbeats.push(m);
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.advance(SHORT_TICK_MS * 4);
    phase = "clean";
    await clock.advance(SHORT_TICK_MS * 3);
    phase = "stuck2";
    await clock.advance(SHORT_TICK_MS * 4);
    watchdog.stop();
    // Two distinct stuck phases → two heartbeats.
    expect(heartbeats.length).toBe(2);
  });

  test("stop() prevents further ticks", async () => {
    const clock = createVirtualClock();
    let captureCount = 0;
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-stop",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => {
        captureCount++;
        return "";
      },
      sendKeys: () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.advance(SHORT_TICK_MS * 3);
    watchdog.stop();
    const countAtStop = captureCount;
    await clock.advance(SHORT_TICK_MS * 5);
    // Deterministic: stop() cancels the pending timer, so zero further ticks.
    expect(captureCount).toBe(countAtStop);
  });

  test("stop() is idempotent", () => {
    const clock = createVirtualClock();
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-idem",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => "",
      sendKeys: () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    watchdog.stop();
    expect(() => watchdog.stop()).not.toThrow();
  });
});

/**
 * Issue #222: tmux capture-pane ETIMEDOUT backoff. When the shared tmux
 * server (`-L claude-hub`) is overloaded by MAX_SESSIONS concurrent
 * watchdogs polling every 5s, capture-pane exceeds its timeout and throws.
 * The watchdog must exponentially back off the failing session's poll
 * (self-throttle) instead of hammering the slow server, then reset to the
 * base interval once a capture succeeds.
 */
describe("dialog-watchdog tmux backoff (#222)", () => {
  test("nextPollInterval: resets to base on a successful capture", () => {
    expect(nextPollInterval(20_000, 5_000, 30_000, true)).toBe(5_000);
    expect(nextPollInterval(5_000, 5_000, 30_000, true)).toBe(5_000);
  });

  test("nextPollInterval: doubles on capture failure", () => {
    expect(nextPollInterval(5_000, 5_000, 30_000, false)).toBe(10_000);
    expect(nextPollInterval(10_000, 5_000, 30_000, false)).toBe(20_000);
  });

  test("nextPollInterval: caps at max backoff", () => {
    expect(nextPollInterval(20_000, 5_000, 30_000, false)).toBe(30_000);
    expect(nextPollInterval(30_000, 5_000, 30_000, false)).toBe(30_000);
  });

  test("backs off when capture throws (fewer calls than a clean poll)", async () => {
    // Both watchdogs share ONE virtual clock so their ticks interleave in the
    // same virtual timeline — the throwing one backs off (longer intervals)
    // and therefore fires strictly fewer captures within the same window.
    const clock = createVirtualClock();
    let throwingCalls = 0;
    const throwing = startDialogWatchdog({
      tmuxSessionName: "test-timeout",
      pollIntervalMs: SHORT_TICK_MS,
      maxBackoffMs: SHORT_TICK_MS * 8,
      capture: () => {
        throwingCalls++;
        const err = new Error("spawnSync tmux ETIMEDOUT");
        (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
        throw err;
      },
      sendKeys: () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    let cleanCalls = 0;
    const clean = startDialogWatchdog({
      tmuxSessionName: "test-clean-baseline",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => {
        cleanCalls++;
        return "no dialog\n";
      },
      sendKeys: () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await clock.advance(SHORT_TICK_MS * 12);
    throwing.stop();
    clean.stop();

    // The clean poller fires at the base rate every tick; the throwing one
    // backs off exponentially, so it must run materially fewer captures.
    expect(throwingCalls).toBeGreaterThan(0);
    expect(throwingCalls).toBeLessThan(cleanCalls);
  });

  test("a throwing capture never triggers a false auto-accept", async () => {
    const clock = createVirtualClock();
    const accepts: DialogMatch[] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-timeout-noaccept",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => {
        throw new Error("spawnSync tmux ETIMEDOUT");
      },
      sendKeys: () => {},
      onAutoAccept: (m) => accepts.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.advance(SHORT_TICK_MS * 4);
    watchdog.stop();
    expect(accepts.length).toBe(0);
  });
});
