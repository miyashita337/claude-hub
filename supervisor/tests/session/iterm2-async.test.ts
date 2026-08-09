import { test, expect, describe } from "bun:test";

/**
 * Tests for #27: markTabStopped should be non-blocking (async/spawn-based).
 *
 * Before fix: markTabStopped uses execSync (blocks event loop).
 * After fix: markTabStopped uses spawn (fire-and-forget, non-blocking).
 *
 * Issue #227 (PR-4): markTabStopped became `async` (its `isItermRunning` gate
 * moved to the async `execFile`). It now returns a Promise instead of void, but
 * the non-blocking guarantee is unchanged: the synchronous portion (scheduling
 * the rename `spawn`) runs before the first `await`, so calling it never blocks
 * the event loop. realItermAdapter still calls it fire-and-forget (`void`).
 *
 * LOCAL-ONLY — deliberately NOT gated in ci.yml (Issue #385; the justification
 * lives in scripts/lint-gating-coverage.ts EXCLUSIONS).
 *
 * The <100ms assertion below is a wall-clock threshold over a window that
 * contains two process spawns (tmux rename-window + pgrep), and process-creation
 * latency is load-dependent on any OS: five local probe runs measured
 * 11/18/33/140/193ms, and this suite failed 2 of 3 consecutive runs on an idle
 * Mac. It is a flake detector, not a regression detector.
 *
 * The invariant it is reaching for — markTabStopped must never block the event
 * loop — IS enforced in CI, deterministically and without a clock, by
 * scripts/lint-no-sync-exec.ts, which bans execSync/execFileSync/spawnSync
 * anywhere under src/session/**. Prefer fixing that lint over this timing check.
 *
 * (For the record: `osascript` is NOT what makes this slow. It is only spawned
 * after `await isItermRunning()` resolves — i.e. outside the measured window.)
 */

describe("markTabStopped non-blocking (#27)", () => {
  test("markTabStopped returns a Promise (fire-and-forget)", async () => {
    const { markTabStopped } = await import("../../src/session/iterm2");
    const result = markTabStopped("nonexistent-channel");
    // async fire-and-forget: returns a Promise the caller may discard (`void`).
    expect(result).toBeInstanceOf(Promise);
  });

  test("markTabStopped does not block event loop for >100ms", async () => {
    const { markTabStopped } = await import("../../src/session/iterm2");
    const start = Date.now();
    markTabStopped("nonexistent-channel");
    const syncElapsed = Date.now() - start;
    // After fix: spawn is non-blocking and the async body yields at the first
    // await, so the synchronous return is immediate (<100ms).
    // Before fix: execSync blocked for the osascript execution time.
    expect(syncElapsed).toBeLessThan(100);
  });
});
