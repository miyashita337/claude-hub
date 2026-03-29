import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import type { SessionManager } from "../session/manager";
import { CHANNEL_MAP, MAX_SESSIONS } from "../config/channels";

export function createSessionCommand() {
  return new SlashCommandBuilder()
    .setName("session")
    .setDescription("Claude Code セッション管理")
    .addSubcommand((sub) =>
      sub.setName("start").setDescription("セッションを起動")
    )
    .addSubcommand((sub) =>
      sub.setName("stop").setDescription("セッションを停止")
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("稼働中セッション一覧")
    )
    .addSubcommand((sub) =>
      sub.setName("resume").setDescription("前回のセッションを復帰")
    );
}

export function createSessionHandler(sessionManager: SessionManager) {
  return async (interaction: ChatInputCommandInteraction) => {
    const subcommand = interaction.options.getSubcommand();
    const channelName = "name" in interaction.channel! ? interaction.channel.name : "";

    switch (subcommand) {
      case "start":
        await handleStart(interaction, sessionManager, channelName);
        break;
      case "stop":
        await handleStop(interaction, sessionManager, channelName);
        break;
      case "list":
        await handleList(interaction, sessionManager);
        break;
      case "resume":
        await handleResume(interaction, sessionManager, channelName);
        break;
    }
  };
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
  channelName: string
): Promise<void> {
  const config = CHANNEL_MAP.get(channelName);
  if (!config) {
    await interaction.reply({
      content: `❌ このチャンネル (${channelName}) は未登録です。\n登録済みチャンネル: ${Array.from(CHANNEL_MAP.keys()).join(", ")}`,
      flags: 64,
    });
    return;
  }

  if (sessionManager.count() >= MAX_SESSIONS) {
    const sessions = sessionManager.listRunning();
    const oldest = sessions.sort(
      (a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime()
    )[0];
    await interaction.reply({
      content: `⚠️ 最大セッション数 (${MAX_SESSIONS}) に達しています。\n\n**選択肢:**\n1. 古いセッションを終了: \`/session stop\` を **#${oldest.channelName}** で実行\n2. 上限を変更（設定ファイルを編集）`,
    });
    return;
  }

  if (sessionManager.has(channelName)) {
    await interaction.reply({
      content: `⚠️ ${config.displayName} のセッションは既に稼働中です。`,
      flags: 64,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const session = sessionManager.start(config);
    await interaction.editReply({
      content: `✅ **${config.displayName}** のセッションを起動しました\n\n` +
        `📁 ディレクトリ: \`${config.dir}\`\n` +
        `🔢 PID: ${session.pid}\n` +
        `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}`,
    });
  } catch (err) {
    await interaction.editReply({
      content: `❌ セッション起動に失敗: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function handleStop(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
  channelName: string
): Promise<void> {
  if (!sessionManager.has(channelName)) {
    await interaction.reply({
      content: `ℹ️ このチャンネルに稼働中のセッションはありません。`,
      flags: 64,
    });
    return;
  }

  await interaction.deferReply();

  try {
    await sessionManager.stop(channelName, "manual");
    await interaction.editReply({
      content: `🛑 セッションを停止しました。\n再開するには \`/session resume\` を使用してください。`,
    });
  } catch (err) {
    await interaction.editReply({
      content: `❌ セッション停止に失敗: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager
): Promise<void> {
  const sessions = sessionManager.listRunning();

  if (sessions.length === 0) {
    await interaction.reply({
      content: `ℹ️ 稼働中のセッションはありません。`,
      flags: 64,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📊 稼働中セッション (${sessions.length}/${MAX_SESSIONS})`)
    .setColor(0x5865f2)
    .setTimestamp();

  for (const session of sessions) {
    const uptime = formatUptime(
      Date.now() - session.startedAt.getTime()
    );
    const idle = formatUptime(
      Date.now() - session.lastActivityAt.getTime()
    );

    embed.addFields({
      name: `#${session.channelName}`,
      value:
        `📁 \`${session.projectDir}\`\n` +
        `⏱️ 稼働: ${uptime} | 無操作: ${idle}\n` +
        `🔢 PID: ${session.pid}`,
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleResume(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
  channelName: string
): Promise<void> {
  const config = CHANNEL_MAP.get(channelName);
  if (!config) {
    await interaction.reply({
      content: `❌ このチャンネル (${channelName}) は未登録です。`,
      flags: 64,
    });
    return;
  }

  if (sessionManager.has(channelName)) {
    await interaction.reply({
      content: `⚠️ ${config.displayName} のセッションは既に稼働中です。`,
      flags: 64,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const session = await sessionManager.resume(config);
    await interaction.editReply({
      content: `🔄 **${config.displayName}** のセッションを復帰しました\n\n` +
        `📁 ディレクトリ: \`${config.dir}\`\n` +
        `🔢 PID: ${session.pid}\n` +
        `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}`,
    });
  } catch (err) {
    await interaction.editReply({
      content: `❌ セッション復帰に失敗: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}日${hours % 24}時間`;
  if (hours > 0) return `${hours}時間${minutes % 60}分`;
  if (minutes > 0) return `${minutes}分`;
  return `${seconds}秒`;
}
