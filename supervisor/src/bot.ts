import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  type Interaction,
  type Message,
  type ThreadChannel,
  type TextChannel,
} from "discord.js";
import { SessionManager } from "./session/manager";
import { Reaper } from "./session/reaper";
import { ActivityWatchdog } from "./session/session-activity-watchdog";
import { ResourceMonitor } from "./session/resource-monitor";
import { createSessionCommand, createSessionHandler } from "./commands/session";
import { CHANNEL_MAP, MAX_SESSIONS } from "./config/channels";
import type { AttachmentInfo } from "./session/relay";
import { buildDialogStuckHandler } from "./session/dialog-stuck-handler";
import { notifyPushover, warnIfPushoverUnconfigured } from "./session/notify-pushover";
import { updateSessionClaudeId } from "./infra/db";
import {
  buildSalvageReply,
  buildStatusReply,
} from "./session/status-reply";
import { onProgress, onLateResponse, onSessionsQuery } from "./session/relay-server";
import {
  extractFilePaths,
  collectAttachableFiles,
} from "./session/file-attacher";
import {
  isKnownSlashCommand,
  loadProjectCommands,
  looksLikeSlashCommand,
  stripLeadingSlash,
} from "./session/slash-prefix";
import { ProgressBuffer } from "./session/progress-buffer";
import { formatForDiscord } from "./session/output-formatter";
import {
  evaluateAccess,
  isDispatchSourceAllowed,
  loadAccessPolicy,
} from "./config/access-policy";
import {
  DISPATCH_PREFIX,
  parseDispatchCommand,
  runDispatch,
} from "./session/dispatch";
import { buildThreadTitle } from "./session/thread-title";

export async function startBot(token: string): Promise<void> {
  // Issue #255: page-ability check at boot. If Pushover creds are missing, the
  // stall heartbeat / dialog watchdog pages silently drop, so warn the operator
  // up front instead of leaving it to be noticed only when a stall fails to page.
  warnIfPushoverUnconfigured();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const sessionManager = new SessionManager();

  // Per-thread message queue: ensures only one message is relayed at a time per thread.
  // Without this, concurrent messages overwrite the pending relay request and responses are lost.
  const threadQueues = new Map<string, Promise<void>>();

  function enqueueForThread(threadId: string, task: () => Promise<void>): void {
    const prev = threadQueues.get(threadId) ?? Promise.resolve();
    // Wrap task in try-catch to prevent unhandled rejections from breaking
    // the promise chain. Without this, one failed relay permanently blocks
    // all subsequent messages for this thread (#41).
    const safeTask = async () => {
      try {
        await task();
      } catch (err) {
        console.error(`[Bot] Unhandled error in thread queue ${threadId}:`, err);
      }
    };
    const next = prev.then(safeTask, safeTask);
    threadQueues.set(threadId, next);
    next.finally(() => {
      if (threadQueues.get(threadId) === next) {
        threadQueues.delete(threadId);
      }
    });
  }
  const reaper = new Reaper(sessionManager, client);
  // Issue #209: nudge the owner when a live session has been running for hours
  // (long_lived, AC3) or has gone silent (quiet, AC1) — the gap between the
  // per-turn stall heartbeat and the 7-day reaper. De-dup is internal so each
  // signal pages at most once per episode.
  const activityWatchdog = new ActivityWatchdog({
    entries: () => sessionManager.entries(),
    isAlive: (threadId) => sessionManager.livenessOf(threadId) === "alive",
    notify: async (threadId, warning) => {
      try {
        const channel = await client.channels.fetch(threadId);
        if (!channel?.isThread()) return;
        console.warn(
          `[Bot] activity-watchdog ${warning.level} on thread ${threadId}`
        );
        await channel.send(warning.message);
        // long_lived is the more serious "is it stuck?" signal — also page
        // Pushover so the owner sees it off-Discord (best-effort).
        if (warning.level === "long_lived") {
          await notifyPushover(
            "Claude Code: 長時間稼働セッション",
            `${channel.name ?? threadId} が長時間稼働中（生存・完了報告なし）— /session status で確認 (#209)`
          ).catch((err) =>
            console.warn("[Bot] activity-watchdog pushover failed:", err)
          );
        }
      } catch (err) {
        console.error(
          `[Bot] activity-watchdog notify error for thread ${threadId}:`,
          err
        );
      }
    },
  });
  const resourceMonitor = new ResourceMonitor(sessionManager);
  const sessionHandler = createSessionHandler(sessionManager);

  // Per-thread progress buffer (Issue #119): coalesce PostToolUse events
  // within a 2-second window so tool-heavy turns don't trip Discord's
  // 5-msg/5-sec rate limit. The buffer fetches the channel and sends the
  // batched body at flush time.
  const progressBuffer = new ProgressBuffer({
    intervalMs: 2000,
    onFlush: async (threadId, entries) => {
      try {
        const channel = await client.channels.fetch(threadId);
        if (!channel?.isThread()) return;
        const lines = entries.map((e) => `🔧 \`${e.tool}\`: ${e.message}`);
        const body =
          lines.length === 1 ? lines[0]! : `🔧 進捗:\n${lines.join("\n")}`;
        // Coalesced bodies can exceed Discord's 2000-char limit when many
        // tools fire within the window — chunk via formatForDiscord before
        // sending so channel.send() doesn't 400.
        for (const chunk of formatForDiscord(body)) {
          await channel.send(chunk);
        }
      } catch (err) {
        console.error(
          `[Bot] Progress flush error for thread ${threadId}:`,
          err
        );
      }
    },
  });

  // Register slash commands
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Bot] Logged in as ${readyClient.user.tag}`);
    console.log(
      `[Bot] Registered channels: ${Array.from(CHANNEL_MAP.keys()).join(", ")}`
    );

    const rest = new REST({ version: "10" }).setToken(token);
    const command = createSessionCommand();

    try {
      const guilds = readyClient.guilds.cache;
      for (const [guildId, guild] of guilds) {
        await rest.put(
          Routes.applicationGuildCommands(readyClient.user.id, guildId),
          { body: [command.toJSON()] }
        );
        console.log(`[Bot] Slash commands registered for guild: ${guild.name}`);
      }
    } catch (err) {
      console.error("[Bot] Failed to register slash commands:", err);
    }

    reaper.start();
    activityWatchdog.start();
    resourceMonitor.start();

    // Register progress callback to send tool progress to Discord threads.
    // Events are buffered (Issue #119) and flushed every 2s as a single
    // message per thread to stay under Discord's 5-msg/5-sec rate limit.
    onProgress((event) => {
      // Issue #209: a session streaming PostToolUse progress is *not* silent.
      // Refresh lastActivityAt here so the activity watchdog's "quiet" signal
      // (AC1) doesn't false-positive on a session that is actively reporting
      // tool progress between relay turns (the relay path only touches activity
      // when a turn completes). This is the first live caller of touchActivity.
      // touchActivity also persists via updateSessionActivity (one small
      // UPDATE-by-id); at MAX_SESSIONS=10 the per-event write rate is trivial
      // for SQLite WAL, and the watchdog/reaper both read the in-memory value.
      sessionManager.touchActivity(event.threadId);
      progressBuffer.add(event.threadId, {
        tool: event.tool,
        message: event.message,
      });
    });

    // Issue #78 (AC-4): back the read-only GET /health/sessions endpoint with a
    // live snapshot of the manager's in-memory sessions so an E2E harness can
    // verify the thread → tmux session mapping without host access.
    onSessionsQuery(() => sessionManager.sessionsHealth());

    // Register late-response callback: when a Stop hook POST arrives after
    // the initial relay already resolved (e.g. Monitor/background-task split
    // a single user turn into multiple assistant turns), forward the follow-up
    // text directly to the Discord thread so it isn't dropped.
    onLateResponse(async (event) => {
      try {
        const channel = await client.channels.fetch(event.threadId);
        if (!channel?.isThread()) return;
        console.log(
          `[Bot] Late response for thread ${event.threadId} (${event.chunks.length} chunks, ${event.text.length} chars)`
        );
        for (const chunk of event.chunks) {
          if (chunk.trim()) {
            await channel.send(chunk);
          }
        }
        // Issue #204: a late Stop event (Monitor-split turn) can still be the
        // turn where context crossed into rot territory — run the same
        // per-thread budget check so this path warns too. The tracker is shared
        // with the main relay path, so de-dup holds across both.
        try {
          const budget = sessionManager.contextBudgetWarning(
            event.threadId,
            event.contextTokens
          );
          if (budget) {
            console.warn(
              `[Bot] context-budget ${budget.level} on thread ${event.threadId} (late): ${budget.tokens} tokens`
            );
            await channel.send(budget.message);
            if (budget.level === "red" || budget.level === "critical") {
              await notifyPushover(
                "Claude Code: コンテキスト肥大化",
                `${channel.name ?? event.threadId} (${budget.level}, ${Math.floor(budget.tokens / 1000)}k tokens) — /session compact 推奨 (#204)`
              ).catch((err) =>
                console.warn(`[Bot] context-budget pushover failed (late):`, err)
              );
            }
          }
        } catch (budgetErr) {
          console.warn(
            `[Bot] context-budget check failed (late) for thread ${event.threadId}:`,
            budgetErr
          );
        }
      } catch (err) {
        console.error(`[Bot] Late response send error for thread ${event.threadId}:`, err);
      }
    });
  });

  // Safe reply helper: never throws. Used in error paths where the interaction may
  // already be stale (Mac sleep/wake can expire the 3-second initial-response token).
  async function safeReplyError(
    interaction: Interaction,
    err: unknown
  ): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    const content = `❌ エラーが発生しました: ${err instanceof Error ? err.message : String(err)}`;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, flags: 64 });
      }
    } catch (replyErr) {
      // Interaction token may be expired or already acknowledged. Log and swallow
      // rather than letting this bubble up as an unhandled rejection.
      console.error("[Bot] safeReplyError: failed to notify user:", replyErr);
    }
  }

  // Handle slash commands
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "session") return;

    // Explicit .catch() ensures the async chain can never leak an unhandled rejection.
    sessionHandler(interaction).catch(async (err) => {
      console.error("[Bot] Command error:", err);
      await safeReplyError(interaction, err);
    });
  });

  // Issue #32 / S7 (dispatch transport): handle a `/dispatch <branch> <issue>`
  // message from an allowed external source (webhook / bot). Returns true when
  // the message was a dispatch attempt and was fully handled (caller must stop),
  // false when it is not a dispatch and normal processing should continue.
  //
  // This is the ONLY exception to the blanket `message.author.bot` drop, and it
  // is fail-closed at every step: the channel must be a known department channel
  // AND configured in the access policy, the source must be enumerated in
  // `dispatchFrom` / `DISPATCH_ALLOWED_SOURCE_IDS`, the branch passes the RW-045
  // metachar / traversal guard, and the issue number must be a positive integer.
  async function handleDispatchMessage(message: Message): Promise<boolean> {
    // Dispatch only applies to a non-thread message in a known department
    // channel whose text starts with the dispatch token.
    if (message.channel.isThread()) return false;
    const content = message.content ?? "";
    if (
      content.trim() !== DISPATCH_PREFIX &&
      !content.trim().startsWith(DISPATCH_PREFIX + " ")
    ) {
      return false;
    }

    const channelName =
      "name" in message.channel ? (message.channel.name as string) : "";
    const config = CHANNEL_MAP.get(channelName);
    if (!config) {
      // Unknown channel: not a valid dispatch target. Treat as "not handled"
      // so a non-bot author still flows through normal processing; a bot author
      // is dropped by the caller's bot guard.
      return false;
    }
    const channelId = message.channel.id;

    // Authorize the SOURCE (webhook / bot id). Fail-closed.
    const decision = isDispatchSourceAllowed(
      loadAccessPolicy(),
      channelId,
      message.author.id,
    );
    if (!decision.allowed) {
      // Identifier-free denial log; never log the source/channel snowflake or
      // the message body.
      console.warn(
        `[Bot] Dispatch denied (reason=${decision.reason}) in channel ${channelName}; not started`
      );
      // Consume (drop) the message regardless of bot/human. By here it is a
      // `/dispatch` in a known department channel and — per the isThread guard
      // at the top — a non-thread message, which the normal relay path never
      // acts on anyway. Returning a hard `true` stops it explicitly so a future
      // refactor of the relay path below cannot let a denied source reach the
      // privileged session start. (Was `return message.author.bot`: correct but
      // fragile — both review lenses flagged the implicit semantics.)
      return true;
    }

    const parsed = parseDispatchCommand(content);
    if (parsed.kind === "not_dispatch") {
      return false;
    }
    if (parsed.kind === "error") {
      console.warn(
        `[Bot] Dispatch rejected (${parsed.reason}) in channel ${channelName}`
      );
      return true;
    }

    const { branch, issueNumber, command } = parsed;
    console.log(
      `[Bot] Dispatch accepted in channel ${channelName} (branch len=${branch.length}, issue=${issueNumber}, mode=${command})`
    );

    const textChannel = message.channel as TextChannel;
    const result = await runDispatch({
      config,
      branch,
      issueNumber,
      command,
      sessionManager,
      createThread: async (b: string) => {
        // Sequence suffix only when another session is already live on the same
        // branch (mirrors handleStart / RW-046 same-branch multi-session).
        const sameBranchCount = sessionManager
          .listRunningByChannel(channelName)
          .filter((s) => s.branch === b).length;
        const threadName = buildThreadTitle(
          "running",
          b,
          config.displayName,
          sameBranchCount + 1
        );
        const thread = await textChannel.threads.create({
          name: threadName,
          autoArchiveDuration: 10080, // 7 days
        });
        return { id: thread.id };
      },
    });

    if (result.ok) {
      try {
        const thread = await client.channels.fetch(result.threadId);
        if (thread?.isThread()) {
          await thread.send(
            `🛰️ **${config.displayName}** をディスパッチで起動しました\n\n` +
              `🌿 ブランチ: \`${branch}\`\n` +
              `▶️ 初期コマンド: \`${result.injected}\`\n` +
              `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}`
          );
        }
      } catch (err) {
        console.error(
          `[Bot] Dispatch welcome message failed for thread ${result.threadId}:`,
          err
        );
      }
    } else {
      console.error(
        `[Bot] Dispatch failed (stage=${result.stage}) in channel ${channelName}: ${result.error}`
      );
    }
    return true;
  }

  // Message relay: thread messages → Claude Code → thread reply
  client.on(Events.MessageCreate, async (message: Message) => {
    // Issue #32 / S7 (dispatch transport): intercept `/dispatch` from an allowed
    // external source BEFORE the blanket bot/webhook drop below. Only an
    // authorized source on a known, policy-configured channel can start a
    // session this way (fail-closed inside handleDispatchMessage).
    try {
      if (await handleDispatchMessage(message)) return;
    } catch (err) {
      console.error("[Bot] Dispatch handler error:", err);
      return;
    }

    if (message.author.bot) return;

    // Only handle messages in threads
    if (!message.channel.isThread()) {
      // Legacy: touch activity for channel-based messages
      const channelName =
        "name" in message.channel ? (message.channel.name as string) : "";
      if (channelName && CHANNEL_MAP.has(channelName)) {
        // No-op in thread-based mode, but keep for compatibility
      }
      return;
    }

    const threadId = message.channel.id;

    // Issue #32 / S7 (Critical): enforce access.json `allowFrom` / `requireMention`
    // BEFORE any relay or response. The relayed session runs with
    // `--dangerously-skip-permissions`, so an un-gated message is lateral
    // movement. Fail-closed: a missing / broken policy or an undefined channel
    // denies. Threads inherit their parent channel's opt-in, so the policy is
    // keyed on the parent channel id (matching the upstream channel server gate).
    {
      const parentChannelId = message.channel.parentId ?? threadId;
      const botUserId = client.user?.id;
      const isMention = botUserId
        ? message.mentions.users.has(botUserId)
        : false;
      const decision = evaluateAccess({
        channelKey: parentChannelId,
        userId: message.author.id,
        isMention,
      });
      if (!decision.allowed) {
        // Structured, identifier-free denial log. Never log the user/channel
        // snowflakes or message body so transcripts can't leak them.
        console.warn(
          `[Bot] Access denied (reason=${decision.reason}) for thread ${threadId}; message not relayed`
        );
        return;
      }
    }

    // No active in-memory session for this thread. Previously the bot silently
    // ignored the message (Issue #41 debug log), leaving the user staring at a
    // dead thread with no feedback (Epic #166). When the bot is @mentioned,
    // reply with the authoritative liveness verdict (Issue #168) plus the
    // claude_session_id and resume command so the session can be salvaged
    // (Issue #169). Non-mention messages keep the quiet debug log to avoid
    // spamming a dead thread on every line.
    if (!sessionManager.has(threadId)) {
      const botUserId = client.user?.id;
      const mentioned = botUserId
        ? message.mentions.users.has(botUserId)
        : false;
      if (!mentioned) {
        console.debug(
          `[Bot] Ignoring message in thread ${threadId} (no active session)`
        );
        return;
      }
      const salvage = buildSalvageReply(sessionManager, threadId);
      try {
        await (message.channel as ThreadChannel).send(salvage);
      } catch (err) {
        console.error(
          `[Bot] Failed to send salvage reply in thread ${threadId}:`,
          err
        );
      }
      return;
    }

    const thread = message.channel as ThreadChannel;

    // Status token (#170): `@Supervisor status` in a live thread returns the
    // session's liveness + claude_session_id WITHOUT relaying the query into
    // the session. Exact token only (mention + "status", case-insensitive) so a
    // real work message that merely contains the word "status" is never
    // hijacked — no NL detection (RW-020/027 lesson). The /session status slash
    // command (commands/session.ts) is the equivalent deterministic trigger.
    {
      const botUserId = client.user?.id;
      if (botUserId && message.mentions.users.has(botUserId)) {
        const withoutMention = message.content
          .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
          .trim()
          .toLowerCase();
        if (withoutMention === "status") {
          try {
            await thread.send(buildStatusReply(sessionManager, threadId));
          } catch (err) {
            console.error(
              `[Bot] Failed to send status reply in thread ${threadId}:`,
              err
            );
          }
          return;
        }
      }
    }

    // Collect attachments
    const attachments: AttachmentInfo[] = [];
    for (const [, att] of message.attachments) {
      attachments.push({
        url: att.url,
        filename: att.name ?? "attachment",
        contentType: att.contentType ?? "application/octet-stream",
      });
    }

    // Build the message text
    let messageText = message.content;
    if (!messageText && attachments.length > 0) {
      messageText = "添付ファイルを確認してください。";
    }
    if (!messageText) return;

    // Slash-prefix stripping: `/hanle-review XXX` → `hanle-review XXX`. Without
    // this, Claude Code's Ink TUI enters its slash-command picker on `/`, and
    // for a typo it stays open silently, hanging the per-thread relay queue
    // until RELAY_TIMEOUT_MS — the bot looks idle to the user (Issue #86).
    // Paths like `/usr/bin/ls` are intentionally not matched by
    // looksLikeSlashCommand and pass through unchanged.
    //
    // Issue #86 follow-up: known slash commands (built-ins + ~/.claude/commands)
    // are now passed through unmodified so legitimate `/save-session` etc. keep
    // working as actual Claude Code slash commands. Strip only fires on
    // unknown / typo'd commands.
    // Issue #155: also recognise PROJECT-scoped commands for this session's
    // cwd (`<projectDir>/.claude/commands/*.md`), not just built-ins +
    // user-global. Without this, a legit project command like
    // `/write-article` is judged "unknown" and demoted to natural language.
    // A session is guaranteed to exist here (the `!has` early-return above),
    // but guard defensively in case of a teardown race.
    const session = sessionManager.get(threadId);
    const projectLoader = session
      ? () => loadProjectCommands(session.projectDir)
      : undefined;
    if (
      looksLikeSlashCommand(messageText) &&
      !isKnownSlashCommand(messageText, undefined, projectLoader)
    ) {
      const original = messageText;
      messageText = stripLeadingSlash(messageText);
      // Log only the leading token (the slash command name) and the message
      // length to mirror other relay logs (L246) and avoid leaking the
      // user-supplied argument body through stdout (PR #115 nitpick — PII).
      const firstToken = original.split(/\s/, 1)[0] ?? "";
      console.log(
        `[Bot] Stripped slash prefix in thread ${threadId} (token="${firstToken.slice(0, 32)}", len=${original.length})`
      );
      // Fire-and-forget: do NOT await. Awaiting Discord's send ACK before the
      // enqueueForThread call below would let a later message in the same
      // thread race past this notification's latency and enter the queue
      // first, breaking message ordering (gemini-code-assist review on PR
      // #115). The notification is purely informational; the queue must
      // observe the original arrival order.
      thread
        .send(
          `ℹ️ \`/\` 始まりの入力は Claude Code TUI のスラッシュピッカーで詰まる現象を避けるため \`/\` を除去して送信します（自然言語として処理されます。Issue #86）。`
        )
        .catch((err: unknown) => {
          console.warn(
            `[Bot] Failed to post slash-strip notice to thread ${threadId}:`,
            err
          );
        });
    }

    // Enqueue to prevent concurrent relay for the same thread.
    // Without this, the second message overwrites the first's pending request
    // in relay-server and the first response is lost.
    enqueueForThread(threadId, async () => {
      // Processing indicator (Issue #7): react ⏳ + refresh sendTyping every 5s.
      // Discord's typing indicator times out after ~10s so a single call masks
      // long-running relays as "idle" — refresh it on an interval until the
      // relay completes, then swap ⏳ for ✅ (success) or ⚠️ (failure).
      let reactedHourglass = false;
      try {
        await message.react("⏳");
        reactedHourglass = true;
      } catch (err) {
        console.warn(
          `[Bot] Failed to react ⏳ in thread ${threadId}:`,
          err
        );
      }
      try {
        await thread.sendTyping();
      } catch {
        // Ignore typing errors
      }
      const typingInterval = setInterval(() => {
        thread.sendTyping().catch(() => {
          // Best-effort during long relay; transient API errors are non-fatal.
        });
      }, 5000);

      let relaySucceeded = false;

      // Relay to Claude Code
      console.log(
        `[Bot] Relaying message in thread ${threadId} (${messageText.length} chars, ${attachments.length} attachments)`
      );
      try {
        const result = await sessionManager.sendMessage(
          threadId,
          messageText,
          attachments,
          // Issue #12: when a dialog slips past auto-accept or the relay
          // stalls on an unknown dialog, page the user on this thread (+
          // best-effort Pushover) with the tmux session to attach to.
          { onDialogStuck: buildDialogStuckHandler(thread) }
        );

        console.log(`[Bot] Got ${result.chunks.length} chunks, error: ${result.error ?? "none"}`);

        // Save Claude session ID on first response
        if (result.claudeSessionId) {
          const session = sessionManager.get(threadId);
          if (session && !session.claudeSessionId) {
            session.claudeSessionId = result.claudeSessionId;
            updateSessionClaudeId(session.id, result.claudeSessionId);
          }
        }

        // Send response chunks to the thread
        for (const chunk of result.chunks) {
          if (chunk.trim()) {
            console.log(`[Bot] Sending chunk (${chunk.length} chars) to thread`);
            await thread.send(chunk);
            console.log(`[Bot] Chunk sent successfully`);
          }
        }

        // Issue #204: warn when this session has entered context-rot territory.
        // At high context, tool-call markup can degrade to plain text and a
        // tool silently never runs — the relay still resolves (a text turn), so
        // the dialog watchdog / stall heartbeat never fire. The Stop hook
        // reports the context token count; we surface a degraded warning (and
        // page Pushover for red/critical) once per band crossing. Best-effort:
        // a failure here must never affect the already-delivered response.
        try {
          const budget = sessionManager.contextBudgetWarning(
            threadId,
            result.contextTokens
          );
          if (budget) {
            console.warn(
              `[Bot] context-budget ${budget.level} on thread ${threadId}: ${budget.tokens} tokens`
            );
            await thread.send(budget.message);
            if (budget.level === "red" || budget.level === "critical") {
              await notifyPushover(
                "Claude Code: コンテキスト肥大化",
                `${thread.name ?? threadId} (${budget.level}, ${Math.floor(budget.tokens / 1000)}k tokens) — /session compact 推奨 (#204)`
              ).catch((err) =>
                console.warn(`[Bot] context-budget pushover failed:`, err)
              );
            }
          }
        } catch (budgetErr) {
          console.warn(
            `[Bot] context-budget check failed for thread ${threadId}:`,
            budgetErr
          );
        }

        // Forward to vive-reading TTS webhook (fire-and-forget)
        forwardToViveReading(threadId, thread.name ?? "", result.text);

        // Attach generated files referenced in the response text
        try {
          const session = sessionManager.get(threadId);
          if (session && result.text) {
            const paths = extractFilePaths(result.text);
            const { files, oversizeWarnings } = collectAttachableFiles(
              paths,
              session.projectDir
            );
            if (files.length > 0) {
              console.log(
                `[Bot] Attaching ${files.length} file(s) to thread ${threadId}`
              );
              await thread.send({
                content: `📎 生成ファイル (${files.length})`,
                files: files.map((f) => ({
                  attachment: f.absPath,
                  name: f.displayName,
                })),
              });
            }
            if (oversizeWarnings.length > 0) {
              await thread.send(oversizeWarnings.join("\n"));
            }
          }
        } catch (attachErr) {
          console.error(
            `[Bot] File attachment error in thread ${threadId}:`,
            attachErr
          );
        }

        // File-attach failures don't downgrade relay success — the chunks
        // were already delivered and the user has the substantive response.
        relaySucceeded = !result.error;

      } catch (err) {
        console.error(`[Bot] Relay error in thread ${threadId}:`, err);
        try {
          await thread.send(
            `⚠️ Claude Code への中継中にエラーが発生しました: ${(err instanceof Error ? err.message : String(err)).slice(0, 1900)}`
          );
        } catch (sendErr) {
          console.error(`[Bot] Failed to send error notification to thread ${threadId}:`, sendErr);
        }
      } finally {
        clearInterval(typingInterval);
        if (reactedHourglass) {
          try {
            const me = client.user;
            if (me) {
              await message.reactions.cache
                .get("⏳")
                ?.users.remove(me.id);
            }
          } catch (err) {
            console.warn(
              `[Bot] Failed to remove ⏳ reaction in thread ${threadId}:`,
              err
            );
          }
        }
        try {
          await message.react(relaySucceeded ? "✅" : "⚠️");
        } catch (err) {
          console.warn(
            `[Bot] Failed to react ${relaySucceeded ? "✅" : "⚠️"} in thread ${threadId}:`,
            err
          );
        }
      }
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Bot] Shutdown signal received");
    reaper.stop();
    activityWatchdog.stop();
    resourceMonitor.stop();
    // Drain pending progress buffers before tearing down the Discord client
    // so in-flight tool events still reach the user (Issue #119).
    try {
      await progressBuffer.flushAll();
    } catch (err) {
      console.error("[Bot] Progress flushAll error during shutdown:", err);
    }
    progressBuffer.close();
    await sessionManager.shutdownAll();
    client.destroy();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await client.login(token);
}

const VIVE_READING_URL = process.env.VIVE_READING_WEBHOOK_URL ?? "http://localhost:3456/api/webhook";

function forwardToViveReading(threadId: string, channel: string, text: string): void {
  try {
    if (!text?.trim()) return;

    // Strip code blocks before sending to TTS — reading raw code aloud hurts quality
    const cleanedText = text.replace(/```[\s\S]*?```/g, "(コードブロック省略)").trim();
    if (!cleanedText) return;

    fetch(VIVE_READING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "discord",
        channel,
        author: "Claude",
        content: cleanedText,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
      })
      .catch((err: unknown) => {
        // Fire-and-forget: don't let TTS webhook failure affect Discord delivery
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Bot] vive-reading webhook failed for thread ${threadId} (async): ${msg}`);
      });
  } catch (err) {
    // Guard against synchronous exceptions (e.g., malformed URL) — still fire-and-forget
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Bot] vive-reading webhook failed for thread ${threadId} (sync): ${msg}`);
  }
}
