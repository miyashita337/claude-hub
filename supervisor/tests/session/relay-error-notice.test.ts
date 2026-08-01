import { test, expect, describe } from "bun:test";
import {
  RELAY_ERROR_USER_MESSAGE,
  SEND_FAILURE_USER_MESSAGE,
} from "../../src/session/relay";

/**
 * Issue #236 (follow-up of #74): the relay block's OUTER catch in bot.ts used
 * to interpolate `err.message` straight into a Discord message:
 *
 *   `⚠️ ...エラーが発生しました: ${(err instanceof Error ? err.message : String(err)).slice(0, 1900)}`
 *
 * #74 closed the send-keys path (`buildSendFailureResult`), but this catch is a
 * second, independent egress: everything awaited inside the ~100-line relay
 * block that has no inner catch lands here. Node/Bun `Error.message` routinely
 * embeds absolute filesystem paths (`ENOENT: ... open '/Users/<name>/...'`), and
 * `String(err)` on a non-Error throwable can carry anything at all — so the
 * unbounded interpolation (sliced at 1900 chars, i.e. nearly a whole Discord
 * message) posts internal detail into a thread that can have non-owner readers.
 *
 * The fix mirrors #74: Discord gets a fixed, actionable notice; the raw cause
 * stays in `console.error` only.
 *
 * The relay handler is a closure inside `startBot`, so it cannot be called
 * directly from a unit test. The wired guard below therefore asserts the
 * call site at the source level — the same technique
 * `tests/guards/access-enforcement-wired.test.ts` uses for the access gate.
 */
/**
 * Extract the relay block's outer `catch (err) { ... }` body from bot.ts,
 * anchored on its log marker so an unrelated catch elsewhere in the file can
 * never be inspected by mistake.
 *
 * Comments are stripped: the catch is documented with the very tokens the
 * assertions forbid (`err.message`, `String(err)`), and a comment explaining
 * why they are banned must not itself trip the guard — the same false-fire
 * concern `scripts/lint-no-sync-exec.ts` solves with an AST. This block has no
 * string literal containing `//`, so the regex strip is safe here.
 */
async function readRelayCatchBlock(): Promise<string> {
  const src = await Bun.file("src/bot.ts").text();
  const marker = src.indexOf("[Bot] Relay error in thread");
  expect(marker).toBeGreaterThan(-1);
  const start = src.lastIndexOf("catch (err) {", marker);
  const end = src.indexOf("} finally {", marker);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("relay outer-catch notice leaks nothing (#236)", () => {
  test("the canned notice carries no internal detail", () => {
    // No filesystem paths, no error-object shape, no tmux/SQL internals.
    expect(RELAY_ERROR_USER_MESSAGE).not.toMatch(/\/Users\/|\/home\/|\/var\/|\/tmp\//);
    expect(RELAY_ERROR_USER_MESSAGE).not.toMatch(/ENOENT|EACCES|SQLITE|DiscordAPIError/i);
    expect(RELAY_ERROR_USER_MESSAGE).not.toMatch(/Error:|\bat \w+ \(|Command failed|tmux/i);
    // Actionable: tells the user how to recover (same contract as #74).
    expect(RELAY_ERROR_USER_MESSAGE).toContain("/session status");
    expect(RELAY_ERROR_USER_MESSAGE).toContain("/session start");
  });

  test("recovery guidance only names subcommands that actually exist", async () => {
    // Both notices used to point at `/session restart`, which was never
    // registered (#236): session.ts declares start/stop/list/status/resume/
    // compact/keep. Telling a user to run a command that does not exist turns a
    // transient failure into a dead end, so pin the guidance to the real
    // registry rather than to a hand-copied list.
    const cmdSrc = await Bun.file("src/commands/session.ts").text();
    const registered = new Set(
      [...cmdSrc.matchAll(/sub\s*(?:\n\s*)?\.setName\("([a-z]+)"\)/g)].map((m) => m[1]!)
    );
    expect(registered.size).toBeGreaterThan(0);

    for (const notice of [RELAY_ERROR_USER_MESSAGE, SEND_FAILURE_USER_MESSAGE]) {
      const referenced = [...notice.matchAll(/\/session\s+([a-z]+)/g)].map((m) => m[1]!);
      expect(referenced.length).toBeGreaterThan(0);
      for (const sub of referenced) {
        expect(registered).toContain(sub);
      }
    }
  });

  test("bot.ts outer catch sends the canned notice, not the raw error", async () => {
    const block = await readRelayCatchBlock();

    // The user-facing send must be the constant.
    expect(block).toContain("RELAY_ERROR_USER_MESSAGE");
    // No raw error content may be interpolated into the Discord message. The
    // diagnostic `console.error` passes the `err` OBJECT (preserving the stack),
    // so neither stringification form should appear anywhere in this block.
    expect(block).not.toContain("err.message");
    expect(block).not.toContain("String(err)");
  });

  test("bot.ts still logs the raw cause for diagnostics", async () => {
    const block = await readRelayCatchBlock();
    // Sanitizing the user-facing path must not silently drop the diagnostic
    // (agent-output-quality #1: no silent fallback). The err OBJECT is passed,
    // so the stack survives in the Supervisor log.
    expect(block).toMatch(/console\.error\(`\[Bot\] Relay error in thread[^`]*`,\s*err\s*\)/);
  });
});
