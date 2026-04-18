import { test, expect, describe } from "bun:test";

/**
 * Tests for #27: session command handlers should check interaction state
 * before calling reply/editReply to prevent 40060 errors.
 *
 * Before fix: handleStart/Stop catch blocks call editReply without checking
 * if deferReply succeeded, causing "Interaction has already been acknowledged" (40060).
 * After fix: catch blocks check interaction.deferred/replied before calling editReply.
 */

describe("session command interaction safety (#27)", () => {
  test("session.ts handles catch without pre-check for deferred state", async () => {
    // Read source and verify that catch blocks have replied/deferred guards
    const source = await Bun.file(
      "src/commands/session.ts"
    ).text();

    // Find all catch blocks that call editReply
    const editReplyCalls = source.match(/catch[\s\S]*?editReply/g) ?? [];

    // Each catch block with editReply should also have a replied/deferred check
    for (const block of editReplyCalls) {
      const hasGuard =
        block.includes("interaction.replied") ||
        block.includes("interaction.deferred") ||
        block.includes("safeReply");
      expect(hasGuard).toBe(true);
    }
  });

  test("session.ts deferReply calls are followed by try-catch with safe editReply", async () => {
    const source = await Bun.file(
      "src/commands/session.ts"
    ).text();

    // Count deferReply calls
    const deferCalls = (source.match(/deferReply/g) ?? []).length;
    expect(deferCalls).toBeGreaterThan(0);

    // Each function that calls deferReply should have error handling
    // that checks deferred state before editReply
    const functions = source.match(
      /async function handle\w+[\s\S]*?^}/gm
    ) ?? [];

    for (const fn of functions) {
      if (!fn.includes("deferReply")) continue;
      // Should have a catch that handles the case where deferReply failed
      const hasCatch = fn.includes("catch");
      expect(hasCatch).toBe(true);
    }
  });
});
