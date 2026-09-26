// Issue #410: `isBotMentioned` must treat a ROLE mention (e.g. the bot's
// auto-created integration role) the same as a direct user mention, while
// still ignoring `@everyone`/`@here` and a plain reply to the bot.
//
// The fixture below models the exact shape `isBotMentioned` depends on
// (`message.mentions.has(data, opts)`), matching the convention already used
// for discord.js message mocks in tests/discord/real-client.test.ts. The
// underlying discord.js behavior itself (that `has()` resolves a User's
// guild roles for role-mention matching) is verified directly against the
// installed package source — see the comment in src/discord/mentions.ts.

import { describe, expect, test } from "bun:test";
import type { Message, User } from "discord.js";
import { isBotMentioned, stripBotMention } from "../../src/discord/mentions";

const BOT_USER = { id: "bot_1" } as User;

/**
 * Builds a minimal message-shaped fixture whose `mentions.has()` mirrors the
 * real discord.js contract: direct user mention, role mention (only when the
 * "mentioned" role belongs to the target — modeling `guild.members.resolve`
 * + `member.roles.cache.has`), `@everyone`, and replied-user, each gated by
 * the `ignore*` options exactly like the real `MessageMentions#has()`.
 */
function fixture(opts: {
  directUserId?: string;
  roleMentionMatchesBot?: boolean;
  everyone?: boolean;
  repliedUserId?: string;
}): Message {
  return {
    mentions: {
      has: (
        data: { id: string },
        options: {
          ignoreDirect?: boolean;
          ignoreRoles?: boolean;
          ignoreRepliedUser?: boolean;
          ignoreEveryone?: boolean;
        } = {},
      ) => {
        if (!options.ignoreEveryone && opts.everyone) return true;
        if (
          !options.ignoreRepliedUser &&
          opts.repliedUserId &&
          opts.repliedUserId === data.id
        ) {
          return true;
        }
        if (!options.ignoreDirect && opts.directUserId === data.id) {
          return true;
        }
        if (!options.ignoreRoles && opts.roleMentionMatchesBot) return true;
        return false;
      },
    },
  } as unknown as Message;
}

describe("isBotMentioned (#410)", () => {
  test("false when botUser is null (no client user yet)", () => {
    const message = fixture({ directUserId: "bot_1" });
    expect(isBotMentioned(message, null)).toBe(false);
  });

  test("false when botUser is undefined", () => {
    const message = fixture({ directUserId: "bot_1" });
    expect(isBotMentioned(message, undefined)).toBe(false);
  });

  test("true on a direct user mention (<@bot_1>) — non-regression (AC-2)", () => {
    const message = fixture({ directUserId: "bot_1" });
    expect(isBotMentioned(message, BOT_USER)).toBe(true);
  });

  test("true on a role mention (<@&ROLE_ID>) for a role the bot holds (AC-1)", () => {
    // No direct user id in the message content at all — only a role mention
    // resolves to the bot, which is exactly the #410 regression case.
    const message = fixture({ roleMentionMatchesBot: true });
    expect(isBotMentioned(message, BOT_USER)).toBe(true);
  });

  test("false with no mention at all (AC-3)", () => {
    const message = fixture({});
    expect(isBotMentioned(message, BOT_USER)).toBe(false);
  });

  test("false on @everyone / @here alone — not treated as a bot mention (AC-4)", () => {
    const message = fixture({ everyone: true });
    expect(isBotMentioned(message, BOT_USER)).toBe(false);
  });

  test("false on a plain reply to the bot's own message (ignoreRepliedUser)", () => {
    const message = fixture({ repliedUserId: "bot_1" });
    expect(isBotMentioned(message, BOT_USER)).toBe(false);
  });

  test("a mention of another user/role does not count as the bot being mentioned", () => {
    const message = fixture({ directUserId: "someone_else" });
    expect(isBotMentioned(message, BOT_USER)).toBe(false);
  });
});

describe("stripBotMention (#410)", () => {
  test("strips a direct user mention", () => {
    expect(stripBotMention("<@bot_1> status", "bot_1")).toBe(" status");
  });

  test("strips a nickname-form user mention (<@!id>)", () => {
    expect(stripBotMention("<@!bot_1> status", "bot_1")).toBe(" status");
  });

  test("strips a role mention even though it does not encode the user id (#410)", () => {
    // This is the exact case the #410 fix needs: the message never contains
    // the bot's user id at all, only a role mention that resolves to it.
    expect(stripBotMention("<@&999999999999999999> status", "bot_1")).toBe(
      " status",
    );
  });

  test("returns content unchanged when botUserId is undefined", () => {
    expect(stripBotMention("<@bot_1> status", undefined)).toBe(
      "<@bot_1> status",
    );
  });

  test("leaves an unrelated user mention untouched", () => {
    expect(stripBotMention("<@someone_else> status", "bot_1")).toBe(
      "<@someone_else> status",
    );
  });
});
