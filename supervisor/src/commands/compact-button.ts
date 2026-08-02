import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from "discord.js";
import { CompactInFlightError, type SessionManager } from "../session/manager";
import { safeRespond } from "./safe-respond";

/**
 * One-click compact button (Issue #364).
 *
 * `/session compact` is namespaced under `/session` on purpose (#200): a
 * top-level `/compact` would collide with other apps in the same guild. That
 * decision is right, but it left the *only* way to compact behind a command
 * name the owner has to recall exactly — and typing the natural `/compact`
 * lands on another app ("You are not authorized to use this command"), so the
 * user is stuck with no working path.
 *
 * A button closes that gap without reopening the collision: a component
 * interaction is routed by `customId` to the app that sent the message, so it
 * can never be captured by another bot no matter what commands they register.
 */

/**
 * customId for the compact button. Namespaced (`session:`) so future components
 * can share the dispatcher without ambiguity.
 */
export const COMPACT_BUTTON_ID = "session:compact";

/**
 * RW-032: a bare `/compact` produces a bad compact (the model can't predict the
 * next work direction). When no intent is supplied we attach this default so the
 * summary keeps the current state and next action.
 *
 * Lives here rather than in `commands/session.ts` because both the slash command
 * and the button need it, and this module is the one with no dependency on the
 * command builder (keeping the import graph acyclic).
 */
export const DEFAULT_COMPACT_INTENT = "直近の作業状態と次アクションを保持して圧縮";

/** The action row carrying the compact button. */
export function buildCompactButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(COMPACT_BUTTON_ID)
      .setLabel("compact")
      .setEmoji("🗜️")
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Message payload helper for the notification paths (activity nudge #209,
 * context-budget notify #204). `offer` is the caller's judgement of whether
 * compact is the relevant next step; when false the message goes out unchanged,
 * so an unrelated warning never grows a misleading button.
 */
export function withCompactButton(
  content: string,
  offer: boolean
): { content: string; components?: ActionRowBuilder<ButtonBuilder>[] } {
  return offer
    ? { content, components: [buildCompactButtonRow()] }
    : { content };
}

/**
 * Button handler. Mirrors the thread-bound branch of `/session compact` exactly
 * (same guards, same default intent, same ephemeral ack) so the two entry points
 * cannot drift.
 *
 * The claudeHubExit primary-channel branch of the slash command (#199 AC1) is
 * deliberately not mirrored: the button is only attached to thread messages, so
 * that path is unreachable here.
 */
export function createCompactButtonHandler(sessionManager: SessionManager) {
  return async (interaction: ButtonInteraction): Promise<void> => {
    const channel = interaction.channel;

    // The button rides on thread messages, but a component can be clicked long
    // after the fact — re-check rather than trusting where it was posted.
    if (!channel || !channel.isThread()) {
      await interaction.reply({
        content:
          "ℹ️ compact は稼働中セッションのスレッド内でのみ実行できます。",
        flags: 64,
      });
      return;
    }

    const threadId = channel.id;
    if (!sessionManager.has(threadId)) {
      // A stale button on an already-stopped session: report it, never send keys
      // into a dead pane.
      await interaction.reply({
        content:
          "ℹ️ このスレッドに稼働中のセッションはありません" +
          "（既に停止済みか、compact 済みで再起動されています）。",
        flags: 64,
      });
      return;
    }

    await interaction.deferReply({ flags: 64 });

    try {
      await sessionManager.compactSession(threadId, DEFAULT_COMPACT_INTENT);
      await interaction.editReply({
        content: `🗜️ compact を送信しました: \`/compact ${DEFAULT_COMPACT_INTENT}\``,
      });
    } catch (err) {
      // A button stays clickable after the click, so a double-click is the
      // expected way to hit this — report it as "already running", not a
      // failure, and don't invite a third click.
      if (err instanceof CompactInFlightError) {
        await safeRespond(interaction, {
          content: "⏳ compact は既に実行中です。完了までお待ちください。",
          ephemeral: true,
        });
        return;
      }
      const msg = `❌ compact の送信に失敗: ${err instanceof Error ? err.message : String(err)}`;
      await safeRespond(interaction, { content: msg, ephemeral: true });
    }
  };
}
