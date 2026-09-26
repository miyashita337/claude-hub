import { describe, expect, test } from "bun:test";

/**
 * Issue #410: `message.mentions.users.has(botUserId)` only sees a direct user
 * mention, never a role mention (e.g. the bot's auto-created integration
 * role). All five call sites that decided "is the bot mentioned" from that
 * raw check were fixed to go through the shared `isBotMentioned` helper
 * (src/discord/mentions.ts), which also covers role mentions.
 *
 * This guard pins the fix structurally (same shape as
 * access-enforcement-wired.test.ts): a future edit that reintroduces a raw
 * `mentions.users.has(` call would silently reopen the same class of defect
 * (#230 / #267 / #410 — third occurrence), so it is asserted at zero
 * tolerance rather than left to be caught by chance.
 */

async function read(path: string): Promise<string> {
  return Bun.file(path).text();
}

describe("bot mention detection is centralized (#410)", () => {
  test("no raw `mentions.users.has(` remains in src (AC-5)", async () => {
    for (const path of ["src/bot.ts", "src/discord/real-client.ts"]) {
      const src = await read(path);
      expect(src).not.toContain("mentions.users.has(");
    }
  });

  test("bot.ts's four mention-gated call sites all use isBotMentioned", async () => {
    const src = await read("src/bot.ts");
    expect(src).toContain("isBotMentioned");
    expect(src).toContain('from "./discord/mentions"');
    const count = src.split("isBotMentioned(").length - 1;
    // orchestrate access, thread access (requireMention), dead-thread salvage
    // (resolveWakeReply mentioned flag), and the `@Supervisor status` token.
    expect(count).toBe(4);
  });

  test("the `@Supervisor status` token strips role mentions too, not just the user mention", async () => {
    const src = await read("src/bot.ts");
    // #410: isBotMentioned now also fires on a role mention, so the token
    // comparison must strip that token too, or an otherwise-exact "status"
    // command silently stops matching (same failure class as the main bug).
    expect(src).toContain("stripBotMention(message.content, botUserId)");
  });

  test("real-client.ts's relay access gate uses isBotMentioned", async () => {
    const src = await read("src/discord/real-client.ts");
    expect(src).toContain('import { isBotMentioned } from "./mentions"');
    expect(src).toContain("isBotMentioned(message, this.client.user)");
  });
});
