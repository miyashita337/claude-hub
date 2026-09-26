// Shared bot-mention detection (Issue #410).
//
// `message.mentions.users.has(botUserId)` only sees a DIRECT user mention
// (`<@ID>`). Discord auto-creates an integration role for every bot added to
// a guild, and picking the bot from the mention autocomplete sometimes
// inserts a ROLE mention (`<@&ROLE_ID>`) instead — `mentions.users` never
// contains that id, so the direct-only check silently treated the message as
// "not mentioned" (same defect class as #230 / #267; this is the third
// occurrence).
//
// discord.js v14's `MessageMentions#has()` already covers user + role +
// everyone + replied-user mentions in one call. Verified directly against the
// installed package (matches package.json `discord.js: ^14.25.1`) at
// node_modules/discord.js/src/structures/MessageMentions.js `has()`: when
// `data` is a `User`, it resolves the guild's cached `GuildMember` for that
// user id (`guild.members.resolve(data)`) and checks whether any of that
// member's roles intersect the message's mentioned roles
// (`member.roles.cache.has(mentionedRole.id)`) — exactly the role-mention
// case this issue needs, with no extra plumbing required.
import type { Message, User } from "discord.js";

/**
 * Whether `botUser` is mentioned in `message`, counting both a direct user
 * mention (`<@ID>`) and a mention of a role the bot holds (`<@&ROLE_ID>`,
 * e.g. the bot's auto-created integration role).
 *
 * `@everyone` / `@here` are explicitly excluded (`ignoreEveryone: true`) so a
 * broadcast message never counts as an intentional mention, and a plain
 * reply to the bot's own message is excluded too (`ignoreRepliedUser: true`)
 * so replying does not implicitly "mention" it.
 */
export function isBotMentioned(
  message: Message,
  botUser: User | null | undefined,
): boolean {
  if (!botUser) return false;
  return message.mentions.has(botUser, {
    ignoreEveryone: true,
    ignoreRepliedUser: true,
  });
}
