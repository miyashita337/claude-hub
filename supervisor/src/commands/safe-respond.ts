import {
  MessageFlags,
  type EmbedBuilder,
  type RepliableInteraction,
} from "discord.js";

/**
 * Options for {@link safeRespond}. `ephemeral` only takes effect on the
 * fresh-reply path — once an interaction is deferred, its ephemerality is fixed
 * at defer time and `editReply` cannot change it (Discord API constraint), so
 * the flag is intentionally ignored when editing a deferred reply.
 */
export interface SafeRespondOptions {
  content?: string;
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

/**
 * Issue #27 (Task 2, root-fix): route every command response through a single
 * acknowledged-state check so we never hit Discord error `40060`
 * ("Interaction has already been acknowledged").
 *
 * The previous code duplicated `if (interaction.deferred || interaction.replied)
 * { editReply } else { reply }` in six catch blocks. Duplication is the failure
 * mode: a seventh handler can forget the guard, the global handler swallows the
 * 40060, and the user silently gets no response. Centralizing the routing makes
 * the guard impossible to forget — new handlers call `safeRespond` and are
 * correct by construction.
 *
 * - Not yet acknowledged → `reply` (applies `ephemeral` via `flags: 64`).
 * - Already deferred or replied → `editReply` (ephemerality inherited from defer).
 *
 * Typed on `RepliableInteraction` (not just the slash-command interaction) so
 * component handlers get the same guarantee — the compact button (#364) shares
 * this path with `/session compact`.
 */
export async function safeRespond(
  interaction: RepliableInteraction,
  options: SafeRespondOptions
): Promise<void> {
  const { content, embeds, ephemeral } = options;

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({
      ...(content !== undefined ? { content } : {}),
      ...(embeds !== undefined ? { embeds } : {}),
    });
    return;
  }

  await interaction.reply({
    ...(content !== undefined ? { content } : {}),
    ...(embeds !== undefined ? { embeds } : {}),
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
}
