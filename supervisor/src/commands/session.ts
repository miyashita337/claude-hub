import {
  SlashCommandBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type ThreadChannel,
  EmbedBuilder,
} from "discord.js";
import type { SessionManager } from "../session/manager";
import { CHANNEL_MAP, MAX_SESSIONS } from "../config/channels";
import { buildThreadTitle, markTitleStopped } from "../session/thread-title";

export function createSessionCommand() {
  return new SlashCommandBuilder()
    .setName("session")
    .setDescription("Claude Code セッション管理")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("セッションを起動（作業ブランチ専用の worktree で claude を起動）")
        // Issue #154: branch is the working branch for this session. Declared
        // optional at the Discord layer so a missing arg reaches the handler,
        // which returns a migration hint (the old no-arg form is gone).
        .addStringOption((opt) =>
          opt
            .setName("branch")
            .setDescription("作業ブランチ名（例: feature-foo）")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("stop")
        .setDescription("セッションを停止（スレッド内で実行）")
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("稼働中セッション一覧")
    )
    .addSubcommand((sub) =>
      sub
        .setName("resume")
        .setDescription("停止済みセッションを会話履歴付きで復帰（新スレッドで起動）")
        // Issue #161: session_id is required. Declared optional at the Discord
        // layer so a missing arg reaches the handler, which returns a usage hint.
        .addStringOption((opt) =>
          opt
            .setName("session_id")
            .setDescription("復帰する claude session id（/session list で確認できる UUID）")
            .setRequired(false)
        )
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
      case "resume":
        await handleResume(interaction, sessionManager);
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

  // Issue #154 (Q6): branch is required; only an empty/whitespace value is
  // blocked here — git validates the rest. The old no-arg `/session start` is
  // gone, so guide the user to the new form.
  const branch = interaction.options.getString("branch")?.trim() ?? "";
  if (!branch) {
    await interaction.reply({
      content:
        "❌ branch 引数が必須です。`/session start <branch-name>` が新仕様です（例: `/session start feature-foo`）。",
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

  // Tracked so a failure after thread creation (e.g. git worktree error) can
  // clean up the orphan thread instead of leaving a dead "🟢 Session" thread.
  let createdThread: ThreadChannel | null = null;

  try {
    // Issue #175: title by branch, with a sequence suffix only when another
    // session is already live on the *same* branch (RW-046: same-branch
    // multi-session is allowed). Counting same-branch (not channel-wide) keeps
    // distinct branches at "(1)" so they read cleanly.
    const sameBranchCount = sessionManager
      .listRunningByChannel(channelName)
      .filter((s) => s.branch === branch).length;
    const sessionNum = sameBranchCount + 1;
    const threadName = buildThreadTitle(
      "running",
      branch,
      config.displayName,
      sessionNum
    );

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
    createdThread = thread;

    // Start the session with the thread ID — runs claude in a per-branch
    // worktree (Issue #154).
    const session = await sessionManager.start(config, thread.id, branch);

    // Post welcome message in the thread
    const locationLine = session.worktree
      ? `📁 Worktree: \`${session.worktree.path}\`\n🌿 ブランチ: \`${session.worktree.branch}\``
      : `📁 ディレクトリ: \`${config.dir}\``;
    await thread.send(
      `✅ **${config.displayName}** のセッションを開始しました\n\n` +
        `${locationLine}\n` +
        `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}\n\n` +
        `このスレッドにメッセージを送信すると、Claude Code に中継されます。\n` +
        `終了するには \`/session stop\` をこのスレッド内で実行してください。`
    );

    await interaction.editReply({
      content: `✅ セッションをスレッドで起動しました → ${thread}`,
    });
  } catch (err) {
    // Best-effort: drop the orphan thread so a failed start doesn't leave a
    // misleading "🟢 Session" thread with no live session behind it.
    if (createdThread) {
      try {
        await createdThread.delete();
      } catch {
        // Thread already gone or delete not permitted — nothing to recover.
      }
    }
    const msg = `❌ セッション起動に失敗: ${err instanceof Error ? err.message : String(err)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg });
    } else {
      await interaction.reply({ content: msg, flags: 64 });
    }
  }
}

async function handleResume(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager
): Promise<void> {
  // Issue #161: resume a stopped session by its claude session id, in a new
  // thread, with full relay wiring. Invoked from the project's channel (same
  // channel-scoping rule as `start`).
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({
      content: "❌ チャンネル情報を取得できません。",
      flags: 64,
    });
    return;
  }

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

  const sessionId = interaction.options.getString("session_id")?.trim() ?? "";
  if (!sessionId) {
    await interaction.reply({
      content:
        "❌ session_id が必須です。`/session resume <session_id>` で実行してください（`/session list` で UUID を確認できます）。",
      flags: 64,
    });
    return;
  }

  const row = sessionManager.findResumableSession(sessionId);
  if (!row) {
    await interaction.reply({
      content: `❌ session_id が見つかりません: \`${sessionId}\``,
      flags: 64,
    });
    return;
  }
  if (row.channel_name !== channelName) {
    await interaction.reply({
      content: `❌ この session は別チャンネル (\`${row.channel_name}\`) のものです。そのチャンネルで実行してください。`,
      flags: 64,
    });
    return;
  }
  if (row.status === "running") {
    await interaction.reply({
      content: "⚠️ この session は既に稼働中です。`/session list` で確認してください。",
      flags: 64,
    });
    return;
  }

  if (sessionManager.count() >= MAX_SESSIONS) {
    await interaction.reply({
      content: `⚠️ 最大セッション数 (${MAX_SESSIONS}) に達しています。\n古いセッションのスレッドで \`/session stop\` を実行してください。`,
      flags: 64,
    });
    return;
  }

  await interaction.deferReply();

  let createdThread: ThreadChannel | null = null;
  let resumed = false;
  try {
    // Issue #175: resumed thread title matches the start scheme. Branch comes
    // from the original session row (null for pre-migration rows → falls back
    // to a display-name-only title inside buildThreadTitle). Sequence counts
    // same-branch live sessions; with a null branch it counts channel-wide,
    // preserving the legacy "(N)" behaviour.
    const liveSessions = sessionManager.listRunningByChannel(channelName);
    const sessionNum =
      (row.branch
        ? liveSessions.filter((s) => s.branch === row.branch).length
        : liveSessions.length) + 1;
    const threadName = buildThreadTitle(
      "resume",
      row.branch,
      config.displayName,
      sessionNum
    );

    const parentChannel =
      channel.isThread() && channel.parent ? channel.parent : channel;

    if (
      !parentChannel.isTextBased() ||
      parentChannel.isDMBased() ||
      !("threads" in parentChannel)
    ) {
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
    createdThread = thread;

    // Resume in the directory the original session ran in (row.project_dir),
    // not a worktree — `claude --resume` keys the transcript by cwd. Awaited so
    // the resume prompt is confirmed before the welcome message is posted.
    await sessionManager.resumeSession(
      config,
      thread.id,
      sessionId,
      row.project_dir,
      row.branch
    );
    resumed = true;

    await thread.send(
      `♻️ **${config.displayName}** のセッションを復帰しました（resume）\n\n` +
        `📁 ディレクトリ: \`${row.project_dir}\`\n` +
        `🔑 Claude session: \`${sessionId}\`\n` +
        `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}\n\n` +
        `前回の会話を引き継いで再開します。このスレッドにメッセージを送信すると中継されます。\n` +
        `終了するには \`/session stop\` をこのスレッド内で実行してください。`
    );

    await interaction.editReply({
      content: `✅ セッションを復帰しました → ${thread}`,
    });
  } catch (err) {
    // If resumeSession already succeeded, the session is live; a failure in the
    // follow-up notification (welcome message or interaction acknowledgement)
    // must not leave a running session unreachable from Discord. Stop it before
    // discarding the thread (PR #162 review: CodeRabbit Major).
    if (resumed && createdThread) {
      try {
        await sessionManager.stop(createdThread.id, "manual");
      } catch {
        // Best-effort: nothing more to recover if the stop itself fails.
      }
    }
    if (createdThread) {
      try {
        await createdThread.delete();
      } catch {
        // Thread already gone or delete not permitted — nothing to recover.
      }
    }
    const msg = `❌ セッション復帰に失敗: ${err instanceof Error ? err.message : String(err)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg });
    } else {
      await interaction.reply({ content: msg, flags: 64 });
    }
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

    // Update thread name to show stopped. markTitleStopped swaps a leading 🟢
    // (start) or ♻️ (resume) to 🔴 — shared with the reaper so both paths stay
    // consistent (Issue #175).
    const thread = channel as ThreadChannel;
    const stoppedName = markTitleStopped(thread.name);
    await thread.setName(stoppedName);

    // Archive and lock the thread
    await thread.setArchived(true);

    await interaction.editReply({
      content: "🛑 セッションを停止しました。スレッドをアーカイブします。",
    });
  } catch (err) {
    const msg = `❌ セッション停止に失敗: ${err instanceof Error ? err.message : String(err)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg });
    } else {
      await interaction.reply({ content: msg, flags: 64 });
    }
  }
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager
): Promise<void> {
  try {
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
          (session.claudeSessionId ? `🔑 Session: \`${session.claudeSessionId}\`\n` : "") +
          `⏱️ 稼働: ${uptime} | 無操作: ${idle}`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    const msg = `❌ セッション一覧の取得に失敗: ${err instanceof Error ? err.message : String(err)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg });
    } else {
      await interaction.reply({ content: msg, flags: 64 });
    }
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
