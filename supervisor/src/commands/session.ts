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
import { buildStatusReply } from "../session/status-reply";
import { evaluateAccess } from "../config/access-policy";
import { postPreviousSummary } from "../session/session-summary";

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
        .setName("status")
        .setDescription("このスレッドのセッション生死と claude_session_id を表示")
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
    )
    .addSubcommand((sub) =>
      sub
        .setName("compact")
        // Issue #200: namespaced under /session (claude-hub owns it) so it never
        // collides with another bot's top-level /compact in the same guild.
        .setDescription("このスレッドのセッションを compact（コンテキスト圧縮）")
        .addStringOption((opt) =>
          opt
            .setName("intent")
            .setDescription("圧縮時に保持したい意図（省略時は既定の意図文を付与）")
            .setRequired(false)
        )
    );
}

// RW-032: a bare `/compact` produces a bad compact (the model can't predict the
// next work direction). When the user omits an intent we attach this default so
// the summary keeps the current state and next action.
export const DEFAULT_COMPACT_INTENT = "直近の作業状態と次アクションを保持して圧縮";

/**
 * Issue #199 AC1: the claudeHubExit primary channel id, read from the
 * `HIJOGUCHI_CHANNEL_ID` env (same name start-hijoguchi.sh already uses, so the
 * operator sets one value). Read at call time (not module load) so tests and a
 * launchd reload pick it up without rebuilding the importing module.
 *
 * Returns undefined when unset/blank — the compact handler then fails safe to
 * the normal thread-bound path (the primary channel just shows the usage hint),
 * keeping the Supervisor↔claudeHubExit boundary closed unless explicitly wired.
 * Channel ids are kept out of committed source (Issue #63 convention); env-only.
 */
export function claudeHubExitPrimaryChannelId(): string | undefined {
  const id = process.env.HIJOGUCHI_CHANNEL_ID?.trim();
  return id ? id : undefined;
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
      case "status":
        await handleStatus(interaction, sessionManager);
        break;
      case "resume":
        await handleResume(interaction, sessionManager);
        break;
      case "compact":
        await handleCompact(interaction, sessionManager);
        break;
    }
  };
}

async function handleCompact(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager
): Promise<void> {
  const channel = interaction.channel;

  // Issue #199 AC1: the claudeHubExit primary channel is a normal text channel
  // (not a thread) whose long-lived session runs on the DEFAULT tmux socket,
  // outside SessionManager. Route its `/session compact` to compactPrimarySession
  // (claudeHubExit) instead of the thread-bound path. Checked before the
  // isThread() guard precisely because the primary channel is not a thread.
  // Gated on HIJOGUCHI_CHANNEL_ID so it no-ops when the Supervisor isn't wired.
  const primaryChannelId = claudeHubExitPrimaryChannelId();
  if (primaryChannelId && channel?.id === primaryChannelId) {
    const rawIntent = interaction.options.getString("intent")?.trim() ?? "";
    const intent = rawIntent || DEFAULT_COMPACT_INTENT;
    await interaction.deferReply({ flags: 64 });
    try {
      await sessionManager.compactPrimarySession(intent);
      await interaction.editReply({
        content: `🗜️ claudeHubExit に compact を送信しました: \`/compact ${intent}\``,
      });
    } catch (err) {
      const msg = `❌ compact の送信に失敗: ${err instanceof Error ? err.message : String(err)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg });
      } else {
        await interaction.reply({ content: msg, flags: 64 });
      }
    }
    return;
  }

  // compact targets the session bound to *this* thread (like /session stop), so
  // it must run inside a session thread. Outside one, return a usage hint and
  // never send keys (Issue #200 AC-3).
  if (!channel || !channel.isThread()) {
    await interaction.reply({
      content:
        "ℹ️ `/session compact` は稼働中セッションのスレッド内で実行してください。" +
        "スレッドが無ければ `/session start <branch>` か `/session resume <session_id>` で開始できます。",
      flags: 64,
    });
    return;
  }

  const threadId = channel.id;
  if (!sessionManager.has(threadId)) {
    await interaction.reply({
      content:
        "ℹ️ このスレッドに稼働中のセッションはありません。" +
        "`/session start <branch>` か `/session resume <session_id>` で開始してください。",
      flags: 64,
    });
    return;
  }

  // RW-032: never relay a bare /compact. Use the user's intent, or a default
  // that preserves working state + next action.
  const rawIntent = interaction.options.getString("intent")?.trim() ?? "";
  const intent = rawIntent || DEFAULT_COMPACT_INTENT;

  await interaction.deferReply({ flags: 64 });

  try {
    await sessionManager.compactSession(threadId, intent);
    await interaction.editReply({
      content: `🗜️ compact を送信しました: \`/compact ${intent}\``,
    });
  } catch (err) {
    const msg = `❌ compact の送信に失敗: ${err instanceof Error ? err.message : String(err)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg });
    } else {
      await interaction.reply({ content: msg, flags: 64 });
    }
  }
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager
): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !channel.isThread()) {
    await interaction.reply({
      content: "❌ `/session status` はセッションスレッド内で実行してください。",
      flags: 64,
    });
    return;
  }
  // Deterministic status query (Issue #170): authoritative liveness verdict
  // (#168) + claude_session_id. Runs outside the message-relay path, so it can
  // never hijack a real work message.
  await interaction.reply({
    content: buildStatusReply(sessionManager, channel.id),
  });
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

  // Issue #32 / S7 (Critical): enforce access.json `allowFrom` BEFORE starting a
  // session. `/session start` spawns a Claude process running with
  // `--dangerously-skip-permissions`, so an un-gated start is privilege
  // escalation. Fail-closed: missing/broken policy or an undefined channel
  // denies. A slash command is an explicit, structured invocation by the user,
  // so the mention requirement is satisfied — the decisive gate is the per-
  // channel `allowFrom` allowlist. Policy is keyed on the parent channel id
  // (threads inherit their parent's opt-in).
  {
    const parentChannelId =
      channel.isThread() && channel.parentId ? channel.parentId : channel.id;
    const decision = evaluateAccess({
      channelKey: parentChannelId,
      userId: interaction.user.id,
      isMention: true,
    });
    if (!decision.allowed) {
      // Identifier-free denial log; user-facing message stays generic.
      console.warn(
        `[Session] /session start access denied (reason=${decision.reason}) in channel ${channelName}`
      );
      await interaction.reply({
        content:
          "❌ このチャンネルでセッションを開始する権限がありません（アクセスポリシー）。",
        flags: 64,
      });
      return;
    }
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

    // Issue #141: surface the previous-session summary into the thread, since
    // the ECC SessionStart hook only injects it into Claude's invisible context.
    await postPreviousSummary(thread, {
      projectDir: session.worktree?.path ?? config.dir,
      repoRoot: config.dir,
    });

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
  // Issue #171 (穴 A): trust the authoritative liveness verdict (#168), not the
  // DB `status` column. A stale `status='running'` row (process died without a
  // clean stop) must NOT block a legitimate resume; conversely a genuinely-live
  // session must reject. `livenessOfClaudeSession` resolves the latest row for
  // this claude session id and crosses pid + tmux reality. This is a fast-path
  // UX check — `resumeSession` re-checks under the single-flight lock to close
  // the TOCTOU (穴 C).
  if (sessionManager.livenessOfClaudeSession(sessionId) === "alive") {
    await interaction.reply({
      content:
        "⚠️ この session は既に稼働中です。稼働中のスレッドで操作してください（`/session list` で確認できます）。",
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

    // Issue #141: surface the previous-session summary for the resumed
    // project_dir (resume runs in the repo dir, not a worktree).
    await postPreviousSummary(thread, {
      projectDir: row.project_dir,
      repoRoot: config.dir,
    });

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
