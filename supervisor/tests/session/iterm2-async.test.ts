import { test, expect, describe } from "bun:test";

/**
 * Tests for #27: markTabStopped should be non-blocking (async/spawn-based).
 *
 * Before fix: markTabStopped uses execSync (blocks event loop).
 * After fix: markTabStopped uses spawn (fire-and-forget, non-blocking).
 */

describe("markTabStopped non-blocking (#27)", () => {
  test("markTabStopped returns void (fire-and-forget)", async () => {
    const { markTabStopped } = await import("../../src/session/iterm2");
    const result = markTabStopped("nonexistent-channel");
    // fire-and-forget: returns void, no Promise to await
    expect(result).toBeUndefined();
  });

  test("markTabStopped does not block event loop for >100ms", async () => {
    const { markTabStopped } = await import("../../src/session/iterm2");
    const start = Date.now();
    markTabStopped("nonexistent-channel");
    const syncElapsed = Date.now() - start;
    // After fix: spawn is non-blocking, should return immediately (<100ms)
    // Before fix: execSync blocks for the osascript execution time
    expect(syncElapsed).toBeLessThan(100);
  });
});
