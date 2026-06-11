import { test, expect, describe } from "bun:test";
import {
  startDialogWatchdog,
  nextPollInterval,
} from "../../src/session/dialog-watchdog";
import type { DialogMatch } from "../../src/session/dialog-detect";

/**
 * Watchdog unit tests with fake capture / sendKeys. No tmux required.
 *
 * Issue #57 / Phase D-3: verify the auto-accept → heartbeat escalation
 * path. We control time by driving the watchdog at a 5ms tick and waiting
 * a deterministic number of ticks via setTimeout.
 */

const SHORT_TICK_MS = 10;

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("dialog-watchdog", () => {
  test("does not call onAutoAccept when pane is clean", async () => {
    const accepts: DialogMatch[] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-clean",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => "no dialog here\nnormal output\n",
      sendKeys: () => {},
      onAutoAccept: (m) => accepts.push(m),
    });
    await wait(SHORT_TICK_MS * 4);
    watchdog.stop();
    expect(accepts.length).toBe(0);
  });

  test("auto-accepts ink-confirm with C-m", async () => {
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
    });
    await wait(SHORT_TICK_MS * 3);
    watchdog.stop();
    expect(accepts.length).toBeGreaterThanOrEqual(1);
    expect(accepts[0]!.kind).toBe("ink-confirm");
    expect(sentKeys[0]!.session).toBe("test-ink");
    expect(sentKeys[0]!.keys).toEqual(["C-m"]);
  });

  test("auto-accepts bash-yn with y + Enter", async () => {
    const sentKeys: string[][] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-bash",
      pollIntervalMs: SHORT_TICK_MS,
      maxAutoAcceptAttempts: 1,
      capture: () => "rm dangerous\nDo you want to proceed? (y/N)\n",
      sendKeys: (_, keys) => sentKeys.push(keys),
    });
    await wait(SHORT_TICK_MS * 3);
    watchdog.stop();
    expect(sentKeys.length).toBeGreaterThanOrEqual(1);
    expect(sentKeys[0]).toEqual(["y", "C-m"]);
  });

  // Issue #153: the feedback survey must be dismissed with `0`, NEVER `1`
  // (option 1 submits "Bad" feedback). This locks the survey wiring against
  // future regressions.
  test("auto-dismisses feedback-survey with 0 + Enter (never 1)", async () => {
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
    });
    // finally-guard stop() so a thrown assertion can't leak the poll timer.
    try {
      await wait(SHORT_TICK_MS * 3);
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
    });
    // Need at least maxAutoAcceptAttempts + 1 ticks for heartbeat to fire.
    await wait(SHORT_TICK_MS * 6);
    watchdog.stop();

    expect(acceptsFired.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats.length).toBe(1);
    expect(heartbeats[0]!.kind).toBe("ink-confirm");
  });

  test("heartbeat only fires once per dialog instance", async () => {
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
    });
    // Run for many ticks — heartbeat should still fire only once.
    await wait(SHORT_TICK_MS * 10);
    watchdog.stop();
    expect(heartbeats.length).toBe(1);
  });

  test("resets heartbeat state after dialog clears", async () => {
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
    });
    await wait(SHORT_TICK_MS * 4);
    phase = "clean";
    await wait(SHORT_TICK_MS * 3);
    phase = "stuck2";
    await wait(SHORT_TICK_MS * 4);
    watchdog.stop();
    // Two distinct stuck phases → two heartbeats.
    expect(heartbeats.length).toBe(2);
  });

  test("stop() prevents further ticks", async () => {
    let captureCount = 0;
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-stop",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => {
        captureCount++;
        return "";
      },
      sendKeys: () => {},
    });
    await wait(SHORT_TICK_MS * 3);
    watchdog.stop();
    const countAtStop = captureCount;
    await wait(SHORT_TICK_MS * 5);
    // Allow at most 1 stale tick already mid-flight.
    expect(captureCount - countAtStop).toBeLessThanOrEqual(1);
  });

  test("stop() is idempotent", () => {
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-idem",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => "",
      sendKeys: () => {},
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
    });

    await wait(SHORT_TICK_MS * 12);
    throwing.stop();
    clean.stop();

    // The clean poller fires at the base rate every tick; the throwing one
    // backs off exponentially, so it must run materially fewer captures.
    expect(throwingCalls).toBeGreaterThan(0);
    expect(throwingCalls).toBeLessThan(cleanCalls);
  });

  test("a throwing capture never triggers a false auto-accept", async () => {
    const accepts: DialogMatch[] = [];
    const watchdog = startDialogWatchdog({
      tmuxSessionName: "test-timeout-noaccept",
      pollIntervalMs: SHORT_TICK_MS,
      capture: () => {
        throw new Error("spawnSync tmux ETIMEDOUT");
      },
      sendKeys: () => {},
      onAutoAccept: (m) => accepts.push(m),
    });
    await wait(SHORT_TICK_MS * 4);
    watchdog.stop();
    expect(accepts.length).toBe(0);
  });
});
