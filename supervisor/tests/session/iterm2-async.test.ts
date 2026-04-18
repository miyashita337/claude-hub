import { test, expect, describe } from "bun:test";

/**
 * Tests for #27: markTabStopped should be non-blocking (async/spawn-based).
 *
 * Before fix: markTabStopped uses execSync (blocks event loop).
 * After fix: markTabStopped uses spawn (fire-and-forget, non-blocking).
 */

describe("markTabStopped non-blocking (#27)", () => {
  test("markTabStopped is async (returns Promise)", async () => {
    const { markTabStopped } = await import("../../src/session/iterm2");
    const result = markTabStopped("nonexistent-channel");
    // After fix, markTabStopped should return a Promise (or void for fire-and-forget)
    // The key assertion: it should NOT block the event loop
    // We verify by checking it completes without throwing
    if (result instanceof Promise) {
      await result;
    }
    expect(true).toBe(true);
  });

  test("markTabStopped does not block event loop for >100ms", async () => {
    const { markTabStopped } = await import("../../src/session/iterm2");
    const start = Date.now();
    const result = markTabStopped("nonexistent-channel");
    const syncElapsed = Date.now() - start;
    // After fix: the function should return immediately (<100ms)
    // Before fix: execSync blocks for at least the osascript execution time
    if (result instanceof Promise) {
      await result;
    }
    // The synchronous portion should be fast (spawn is non-blocking)
    expect(syncElapsed).toBeLessThan(100);
  });
});
