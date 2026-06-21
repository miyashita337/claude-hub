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
