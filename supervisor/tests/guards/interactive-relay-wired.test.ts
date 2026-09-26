import { test, expect, describe } from "bun:test";

/**
 * Issue #357: the interactive Discord relay must wait for input readiness
 * before typing, like the dispatch / orchestrate transports already do. The
 * relay handler is a closure inside `startBot`, so — as in
 * relay-error-notice.test.ts / access-enforcement-wired.test.ts — the wiring is
 * asserted at the source level: the relay block routes through
 * `relayInteractive` (readiness → sendMessage), never a bare `sendMessage`.
 */
async function readRelayBlock(): Promise<string> {
  const src = await Bun.file("src/bot.ts").text();
  const start = src.indexOf("[Bot] Relay start in thread");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("[Bot] Got ${result.chunks.length} chunks", start);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("interactive relay waits for input readiness (#357)", () => {
  test("the relay block goes through relayInteractive", async () => {
    const block = await readRelayBlock();
    expect(block).toContain("relayInteractive(");
  });

  test("the relay block never calls sessionManager.sendMessage directly", async () => {
    const block = await readRelayBlock();
    expect(block).not.toMatch(/sessionManager\.sendMessage\(/);
  });
});
