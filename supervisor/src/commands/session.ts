import {
  SlashCommandBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type ThreadChannel,
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
      sub
        .setName("stop")
        .setDescription("セッションを停止（スレッド内で実行）")
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("稼働中セッション一覧")
    );
}

export function createSessionHandler(sessionManager: SessionManager) {
  return async (interaction: ChatInputCommandInteraction) => {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "start":
        await handleStart(interaction, sessionManager);
        break;
      case "stop":
        await handleStop(interaction, sessionManager);
        break;
      case "list":
        await handleList(interaction, sessionManager);
        break;
    }
  };
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager
): Promise<void> {
  // Determine channel name — could be invoked from channel or thread
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({
      content: "❌ チャンネル情報を取得できません。",
      flags: 64,
    });
    return;
  }

  // Get the parent channel name (if in a thread, get parent)
  let channelName: string = "";
  if (channel.isThread() && channel.parent) {
    channelName = channel.parent.name ?? "";
  } else if ("name" in channel && typeof channel.name === "string") {
    channelName = channel.name;
  }

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
      content: `⚠️ 最大セッション数 (${MAX_SESSIONS}) に達しています。\n古いセッションのスレッドで \`/session stop\` を実行してください。`,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Count existing sessions in this channel
    const existingSessions = sessionManager.listRunningByChannel(channelName);
    const sessionNum = existingSessions.length + 1;
    const threadName = sessionNum > 1
      ? `🟢 Session: ${config.displayName} (${sessionNum})`
      : `🟢 Session: ${config.displayName}`;

    // Create a thread in the channel
    // Get the text channel to create thread in
    const parentChannel = channel.isThread() && channel.parent
      ? channel.parent
      : channel;

    if (!parentChannel.isTextBased() || parentChannel.isDMBased() || !("threads" in parentChannel)) {
      await interaction.editReply({
        content: "❌ このチャンネルではスレッドを作成できません。",
      });
      return;
    }

    const textChannel = parentChannel as import("discord.js").TextChannel;
    const thread = await textChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080, // 7 days
    });

    // Start the session with the thread ID
    const session = sessionManager.start(config, thread.id);

    // Post welcome message in the thread
    await thread.send(
      `✅ **${config.displayName}** のセッションを開始しました\n\n` +
        `📁 ディレクトリ: \`${config.dir}\`\n` +
        `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}\n\n` +
        `このスレッドにメッセージを送信すると、Claude Code に中継されます。\n` +
        `終了するには \`/session stop\` をこのスレッド内で実行してください。`
    );

    await interaction.editReply({
      content: `✅ セッションをスレッドで起動しました → ${thread}`,
    });
  } catch (err) {
    await interaction.editReply({
      content: `❌ セッション起動に失敗: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function handleStop(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager
): Promise<void> {
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({
      content: "❌ チャンネル情報を取得できません。",
      flags: 64,
    });
    return;
  }

  // Must be invoked inside a session thread
  if (!channel.isThread()) {
    await interaction.reply({
      content: "ℹ️ `/session stop` はセッションスレッド内で実行してください。",
      flags: 64,
    });
    return;
  }

  const threadId = channel.id;
  if (!sessionManager.has(threadId)) {
    await interaction.reply({
      content: "ℹ️ このスレッドに稼働中のセッションはありません。",
      flags: 64,
    });
    return;
  }

  await interaction.deferReply();

  try {
    await sessionManager.stop(threadId, "manual");

    // Update thread name to show stopped
    const thread = channel as ThreadChannel;
    const currentName = thread.name;
    const stoppedName = currentName.replace("🟢", "🔴");
    await thread.setName(stoppedName);

    // Archive and lock the thread
    await thread.setArchived(true);

    await interaction.editReply({
      content: "🛑 セッションを停止しました。スレッドをアーカイブします。",
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
      content: "ℹ️ 稼働中のセッションはありません。",
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
        `🧵 スレッド: <#${session.threadId}>\n` +
        (session.claudeSessionId ? `🔑 Session: \`${session.claudeSessionId.slice(0, 8)}...\`\n` : "") +
        `⏱️ 稼働: ${uptime} | 無操作: ${idle}`,
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed] });
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
