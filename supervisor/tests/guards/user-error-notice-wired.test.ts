import { test, expect, describe } from "bun:test";

/**
 * Issue #360 (follow-up of #74 / #236): guard that the remaining audited
 * leak sites — `safeReplyError` (every slash command / component interaction
 * error) and `handleChannelPost` (the relay-server HTTP handler) in bot.ts —
 * stay sanitized. Both are closures inside `startBot`, so they cannot be
 * imported and called directly from a unit test; this uses the same
 * source-level "wired guard" technique as
 * `tests/session/relay-error-notice.test.ts` (anchored extraction +
 * regex assertions) so a future edit cannot silently reintroduce
 * `err instanceof Error ? err.message : String(err)` at these call sites.
 *
 * The `/session <sub>` command catches (session.ts) and the context-budget
 * self-heal notice (manager.ts) are plain exported functions/methods and are
 * covered behaviorally instead — see tests/commands/session-*.test.ts and
 * tests/session/manager.test.ts ("#360" cases).
 */

async function readSrc(path: string): Promise<string> {
  return Bun.file(path).text();
}

/**
 * Comments are stripped before assertion: this file's own explanatory
 * comments document the forbidden tokens (`err.message`, `String(err)`), and
 * a comment naming them must not itself trip the guard — same technique
 * `tests/session/relay-error-notice.test.ts` uses.
 */
function extractBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * devils-advocate review of #360 (Medium item 3): the original guard only
 * banned the exact literal `err instanceof Error ? err.message : String(err)`
 * — a rename to `${err}`, `(err as Error).message`, or a new local `errMsg()`
 * helper would slip straight through. Ban the whole family of shapes instead
 * of one literal spelling.
 */
function expectNoRawErrLeak(fn: string): void {
  expect(fn).not.toMatch(/err instanceof Error \? err\.message/);
  expect(fn).not.toContain("String(err)");
  expect(fn).not.toMatch(/\$\{\s*err\b/);
  expect(fn).not.toMatch(/\berr\.message\b/);
  expect(fn).not.toMatch(/errMsg\(/);
}

describe("bot.ts safeReplyError stays sanitized (#360)", () => {
  test("builds its content via sanitizedFailureNotice, never raw err interpolation", async () => {
    const src = await readSrc("src/bot.ts");
    const fn = extractBetween(
      src,
      "async function safeReplyError(",
      "// Handle slash commands + message components"
    );
    expect(fn).toContain("sanitizedFailureNotice(");
    expectNoRawErrLeak(fn);
  });

  test("imports sanitizedFailureNotice from the shared user-error-notice module", async () => {
    const src = await readSrc("src/bot.ts");
    expect(src).toMatch(
      /import\s*\{[^}]*sanitizedFailureNotice[^}]*\}\s*from\s*"\.\/session\/user-error-notice"/
    );
  });
});

describe("bot.ts handleChannelPost stays sanitized (#360)", () => {
  test("both catch blocks delegate to the extracted, unit-tested failure builders", async () => {
    const src = await readSrc("src/bot.ts");
    const fn = extractBetween(
      src,
      'const handleChannelPost: ReadyWiringHandlers["relay:channelPost"] = async (',
      "console.log("
    );
    // Issue #360 (devils-advocate review): the sanitization logic itself now
    // lives in channelPostFetchThreadFailure / channelPostSendFailure
    // (session/user-error-notice.ts), which ARE plain functions a unit test
    // can call directly -- see tests/session/user-error-notice.test.ts for
    // the leak-free / info-preserved behavioral assertions. This closure
    // (never invoked by any test -- it only runs inside a live startBot())
    // just delegates to them, so Codecov's patch-coverage gate does not
    // require covering untestable closure lines to pass.
    expect(fn).toContain("return channelPostFetchThreadFailure(threadId, err)");
    expect(fn).toContain("return channelPostSendFailure(sentCount, chunks.length, err)");
    expectNoRawErrLeak(fn);
  });

  test("imports channelPostFetchThreadFailure and channelPostSendFailure from the shared module", async () => {
    const src = await readSrc("src/bot.ts");
    expect(src).toMatch(
      /import\s*\{[^}]*channelPostFetchThreadFailure[^}]*\}\s*from\s*"\.\/session\/user-error-notice"/
    );
    expect(src).toMatch(
      /import\s*\{[^}]*channelPostSendFailure[^}]*\}\s*from\s*"\.\/session\/user-error-notice"/
    );
  });
});
