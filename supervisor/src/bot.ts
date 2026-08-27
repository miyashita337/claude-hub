import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type Interaction,
  type Message,
  type Channel,
  type ThreadChannel,
  type TextChannel,
} from "discord.js";
import { SessionManager, type SelfHealOutcome } from "./session/manager";
import {
  executeSelfHealRestart,
  manualRestartGuidance,
} from "./session/self-heal-restart";
import { Reaper } from "./session/reaper";
import { GoalWatcher } from "./session/goal-watcher";
import { OrphanDispatchReaper } from "./session/orphan-dispatch-reaper";
import { DispatchHealthReaper } from "./session/dispatch-health-reaper";
import { ActivityWatchdog } from "./session/session-activity-watchdog";
import { ResourceMonitor } from "./session/resource-monitor";
import {
  createSessionCommand,
  createSessionHandler,
  claudeHubExitPrimaryChannelId,
} from "./commands/session";
import {
  COMPACT_BUTTON_ID,
  createCompactButtonHandler,
  withCompactButton,
} from "./commands/compact-button";
import {
  createAskComponentHandler,
  hasActiveMultiAsk,
  isAskComponentId,
  postAskChannelNotice,
  postAskUserPrompt,
  postMultiAskUserPrompt,
} from "./commands/ask-components";
import {
  CHANNEL_MAP,
  MAX_SESSIONS,
  type ChannelConfig,
} from "./config/channels";
import { RELAY_ERROR_USER_MESSAGE, type AttachmentInfo } from "./session/relay";
import { buildDialogStuckHandler } from "./session/dialog-stuck-handler";
import { notifyPushover, warnIfPushoverUnconfigured } from "./session/notify-pushover";
import { startActionReceiver, stopActionReceiver } from "./action/receiver";
import { updateSessionClaudeId } from "./infra/db";
import {
  buildSalvageReply,
  buildStatusReply,
} from "./session/status-reply";
import {
  autoResumeThread,
  resolveWakeReply,
} from "./session/auto-resume";
import {
  onProgress,
  onLateResponse,
  onSessionsQuery,
  onHubWork,
  onChannelPost,
  onAskUser,
  onAskExpired,
  hasPendingAsk,
  hasRecentAsk,
  resolveAskUser,
  askExpiredNotice,
} from "./session/relay-server";
import { runHubWork, HUB_WORK_PARENT_CHANNEL } from "./session/hub-work";
import {
  checkHookWiring,
  formatHookWiringAlert,
} from "./infra/hook-wiring-check";
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
  resolveExecutorMode,
  buildDispatchFailureNotice,
} from "./session/dispatch";
import { DispatchQueue } from "./session/dispatch-queue";
import {
  BRIEF_DISABLED_ENV,
  evaluateBriefTrigger,
  isBriefCommand,
  type RecentBrief,
} from "./session/corp-brief";
import {
  createBriefDecisionHandler,
  isBriefDecisionComponentId,
  runBriefDecideFlow,
} from "./session/brief-decision";
import {
  createBriefWindowDeps,
  handleBriefWindowThreadMessage,
  openBriefWindowForBrief,
  parseBriefWindowThreadName,
  type BriefWindowDeps,
  type BriefWindowMessageOutcome,
} from "./session/brief-window";
import {
  ORCHESTRATE_PREFIX,
  parseOrchestrateCommand,
  runOrchestrate,
  findRunningOrchestrator,
  orchestrateBranchName,
  OrchestrateLaunchLock,
} from "./session/orchestrate";
import { AdmissionController } from "./session/admission";
import { buildThreadTitle } from "./session/thread-title";
import {
  createDiscordWiringSurface,
  wireBoot,
  wireReady,
  type ReadyWiringHandlers,
} from "./bot-wiring";

/** Shared context for delivering a self-heal outcome to a thread (Issue #206/#244). */
interface SelfHealCtx {
  thread: ThreadChannel;
  threadId: string;
  sessionManager: SessionManager;
  client: Client;
}

/**
 * Deliver a self-heal outcome to its Discord thread (Issue #206), executing the
 * resume-backed restart when the planner chose it (Issue #244). Shared by the
 * main relay tail and the late-response path so both behave identically. The
 * outcome message is always posted first — for a restart it is the immediate
 * "restarting…" announce, which matters because the resume picker poll can take
 * minutes before the new thread is live.
 */
async function deliverSelfHealOutcome(
  outcome: SelfHealOutcome,
  ctx: SelfHealCtx
): Promise<void> {
  const { thread, threadId } = ctx;
  console.warn(
    `[Bot] context-budget ${outcome.level} on thread ${threadId}: ${outcome.tokens} tokens (action=${outcome.action})`
  );
  // #364: on the notify-only outcome the owner has to act; offer the button.
  // "compact"/"restart" outcomes already self-heal, so a button there would
  // invite a redundant second compact.
  await thread.send(withCompactButton(outcome.message, outcome.action === "notify"));
  if (outcome.action === "restart" && outcome.restart) {
    await runSelfHealRestart(outcome, ctx);
  }
  if (outcome.page) {
    await notifyPushover(
      "Claude Code: コンテキスト肥大化",
      `${thread.name ?? threadId} (${outcome.level}, ${Math.floor(outcome.tokens / 1000)}k tokens, action=${outcome.action}) — self-heal`
    ).catch((err) =>
      console.warn(`[Bot] context-budget pushover failed:`, err)
    );
  }
}

/**
 * Drive the resume-backed restart for a critical-context session (Issue #244):
 * resolve the channel config + parent text channel, then hand the real Discord /
 * SessionManager side effects to {@link executeSelfHealRestart} (which owns the
 * stop→create→resume ordering and the degrade-to-manual path). Defaults ON; the
 * `CONTEXT_SELF_HEAL_RESTART=0` env is an emergency off-switch that degrades to
 * manual `/session resume` guidance without a redeploy.
 */
async function runSelfHealRestart(
  outcome: SelfHealOutcome,
  ctx: SelfHealCtx
): Promise<void> {
  const { thread, threadId, sessionManager, client } = ctx;
  const r = outcome.restart;
  if (!r) return;

  const flag = process.env.CONTEXT_SELF_HEAL_RESTART;
  if (flag === "0" || flag === "false") {
    await thread
      .send(
        manualRestartGuidance(
          r.claudeSessionId,
          "自動 restart は無効化されています (CONTEXT_SELF_HEAL_RESTART=0)"
        )
      )
      .catch((err) =>
        console.warn(`[Bot] self-heal restart (disabled) notice failed:`, err)
      );
    return;
  }

  const config = CHANNEL_MAP.get(r.channelName);
  const parent = thread.parent;
  if (
    !config ||
    !parent ||
    !parent.isTextBased() ||
    parent.isDMBased() ||
    !("threads" in parent)
  ) {
    await thread
      .send(
        manualRestartGuidance(
          r.claudeSessionId,
          "新スレッドを作成できない構成のため"
        )
      )
      .catch((err) =>
        console.warn(`[Bot] self-heal restart (no-thread) notice failed:`, err)
      );
    return;
  }
  const textChannel = parent as TextChannel;

  const result = await executeSelfHealRestart({
    claudeSessionId: r.claudeSessionId,
    tokens: outcome.tokens,
    stopOld: () => sessionManager.stop(threadId, "self_heal_restart"),
    createThread: async () => {
      // Sequence suffix only when another session is already live on the same
      // branch (mirrors handleResume / dispatch).
      const sameBranchCount = sessionManager
        .listRunningByChannel(r.channelName)
        .filter((s) => s.branch === (r.branch ?? undefined)).length;
      const threadName = buildThreadTitle(
        "resume",
        r.branch,
        config.displayName,
        sameBranchCount + 1
      );
      const nt = await textChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080, // 7 days
      });
      return { id: nt.id, mention: `<#${nt.id}>` };
    },
    resume: async (newThreadId) => {
      await sessionManager.resumeSession(
        config,
        newThreadId,
        r.claudeSessionId,
        r.projectDir,
        r.branch
      );
    },
    notifyOld: async (m) => {
      await thread.send(m);
    },
    notifyNew: async (id, m) => {
      const c = await client.channels.fetch(id);
      if (c?.isThread()) await c.send(m);
    },
  });

  if (!result.ok) {
    console.warn(
      `[Bot] self-heal restart degraded for thread ${threadId}: ${result.error ?? "unknown"}`
    );
  } else {
    console.log(
      `[Bot] self-heal restart: thread ${threadId} → ${result.newThreadId}`
    );
  }
}

/**
 * Structural surfaces for {@link notifyAskParentChannel}, kept deliberately
 * minimal so a test can drive the function with plain fakes (review on #447,
 * should-1) while the real discord.js `Client` / `AnyThreadChannel` remain
 * assignable. `send` is optional because a thread's parent can be a forum /
 * media channel, which discord.js types without `.send()` — the runtime guard
 * below is what rules those out.
 */
export interface AskNoticeParentCandidate {
  isTextBased(): boolean;
  isDMBased(): boolean;
  /** Content-only on purpose: a notice never carries components (#447). */
  send?(options: { content: string }): Promise<unknown>;
}

export interface AskNoticeThreadRef {
  id: string;
  parentId: string | null;
  parent: AskNoticeParentCandidate | null;
}

export interface AskNoticeClient {
  channels: { fetch(id: string): Promise<AskNoticeParentCandidate | null> };
}

/**
 * Issue #447: after an AskUserQuestion landed in a thread, post a one-line
 * "📥 決裁待ち N 件 → <thread>" notice to the thread's parent channel so the
 * pending decision is visible without opening the thread. Best-effort by
 * design: the question is already posted and answerable, so a notice failure
 * only costs discoverability — it is logged and swallowed, never rethrown into
 * the ask path.
 */
export async function notifyAskParentChannel(
  client: AskNoticeClient,
  thread: AskNoticeThreadRef,
  questionCount: number,
): Promise<void> {
  try {
    // thread.parent はキャッシュ依存のゲッターで、起動直後などキャッシュ外だと
    // 実在する親でも null を返す（PR #340 gemini high）。parentId からの明示
    // fetch にフォールバックする（channel-post 経路と同じパターン）。
    let parent: AskNoticeParentCandidate | null = thread.parent;
    if (!parent && thread.parentId) {
      parent = await client.channels.fetch(thread.parentId);
    }
    // isTextBased ガード: フォーラム等 send を持たない親には投稿できない。
    // 解決できない場合も質問自体はスレッドで生きているため warn 止まり。
    if (
      !parent ||
      !parent.isTextBased() ||
      parent.isDMBased() ||
      typeof parent.send !== "function"
    ) {
      console.warn(
        `[Bot] ask notice skipped: cannot resolve a text parent channel for thread ${thread.id}`,
      );
      return;
    }
    await postAskChannelNotice({ send: parent.send.bind(parent) }, {
      threadId: thread.id,
      questionCount,
    });
  } catch (err) {
    console.error(
      `[Bot] Failed to post ask notice to parent channel of thread ${thread.id}:`,
      err,
    );
  }
}

export async function startBot(token: string): Promise<void> {
  // Issue #255: page-ability check at boot. If Pushover creds are missing, the
  // stall heartbeat / dialog watchdog pages silently drop, so warn the operator
  // up front instead of leaving it to be noticed only when a stall fails to page.
  warnIfPushoverUnconfigured();

  // Issue #305 (層3): Pushover one-tap action receiver. Fire-and-forget so a
  // slow Tailscale IP probe never delays Discord login, and fully self-contained
  // (never throws) so a missing key / no tailnet IP disables the endpoint with a
  // WARN without taking the bot down.
  startActionReceiver()
    .then((r) => {
      if (!r.started) {
        console.warn(`[Bot] action receiver not started (${r.reason})`);
      }
    })
    .catch((err) => {
      console.warn("[Bot] action receiver start error (endpoint off, bot unaffected):", err);
    });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const sessionManager = new SessionManager();

  // Issue #383: every startup registration goes through this surface instead of
  // calling client.on / relay-server on* / process.on directly. src/bot-wiring.ts
  // owns the id → target map, so tests can replay the same wiring against
  // in-memory targets and assert nothing was dropped or mis-targeted (#370 was
  // a subscriber that existed but was never wired, undetectable in CI).
  const wiringSurface = createDiscordWiringSurface({
    client,
    relay: {
      onProgress,
      onSessionsQuery,
      onAskUser,
      onAskExpired,
      onLateResponse,
      onHubWork,
      onChannelPost,
    },
    sessionManager,
    signals: process,
  });

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
  // corp #52 M3 (spec §7): auto-stop dispatch-origin sessions (branch
  // `corp-dispatch-<N>`) once their Issue carries the `done` label, after a
  // grace window the chairman can cancel by speaking. Frees the shared session
  // slot on goal completion instead of waiting for the idle reaper.
  const goalWatcher = new GoalWatcher(sessionManager, client);
  // Issue #275 (option B): the self-contained claude-hub half of the dispatch
  // lifecycle gap. A dispatch session (branch `corp-dispatch-<N>`) whose spawning
  // corp CEO session exited but which never reached `done` is orphaned —
  // GoalWatcher (done-only) skips it and the 30-day idle Reaper is far too slow,
  // so it squats a MAX_SESSIONS slot (executor saturation). The supervisor cannot
  // observe the corp CEO exit (corp is a separate process posting /dispatch
  // messages), so this idle-based safety net reaps dispatch sessions idle past
  // DISPATCH_ORPHAN_IDLE_MS while sparing any that are still actively working.
  const orphanDispatchReaper = new OrphanDispatchReaper(sessionManager, client);
  // Issue #279: the health-aware front line for the same executor-saturation
  // problem. Escalates ActivityWatchdog's nudge to auto-reap for dispatch
  // sessions silent past DISPATCH_HEALTH_SILENCE_MS (2h) that also have NO live
  // CI/build/test/push child process (the mis-fire guard — a session waiting on
  // a long CI run looks silent but must not be killed mid-work). The 48h
  // orphanDispatchReaper above stays as the coarse backstop for anything spared.
  const dispatchHealthReaper = new DispatchHealthReaper(sessionManager, client);
  // Issue #209: nudge the owner when a live session has been running for hours
  // (long_lived, AC3) or has gone silent (quiet, AC1) — the gap between the
  // per-turn stall heartbeat and the idle reaper. De-dup is internal so each
  // signal pages at most once per episode.
  const activityWatchdog = new ActivityWatchdog({
    entries: () => sessionManager.entries(),
    isAlive: async (threadId) =>
      (await sessionManager.livenessOf(threadId)) === "alive",
    // Issue #416: don't nudge a session that is waiting on the user's answer.
    isAwaitingAsk: hasPendingAsk,
    notify: async (threadId, warning) => {
      try {
        const channel = await client.channels.fetch(threadId);
        if (!channel?.isThread()) return;
        console.warn(
          `[Bot] activity-watchdog ${warning.level} on thread ${threadId}`
        );
        // #364: long_lived is the nudge that tells the owner to consider
        // compacting, so give it a button they can press instead of a command
        // name they have to retype (and mistype into another app's /compact).
        // The quiet nudge is about silence, not context — no button there.
        await channel.send(
          withCompactButton(warning.message, warning.level === "long_lived")
        );
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
  // Phase 5c (#294): dispatch concurrency limiter + FIFO queue. Only
  // handleDispatchMessage submits here; interactive /session start bypasses it
  // (AC-3). The SessionManager frees a slot when a dispatch session ends.
  const dispatchQueue = new DispatchQueue();
  const handleSessionEnd = (threadId: string): void =>
    dispatchQueue.notifyEnded(threadId);
  // Phase 5d (#295): dynamic admission (WARN-first). Default observe-only — logs a
  // WARN under high load but does not delay; enforcement is opt-in via
  // DISPATCH_ADMISSION_ENFORCE=1.
  const admissionController = new AdmissionController();
  // Epic #316 Phase 1 (#318, PR #324 review): per-channel in-flight lock so two
  // rapid /orchestrate messages cannot both pass the duplicate-launch guard
  // before the first session registers (TOCTOU).
  const orchestrateLaunchLock = new OrchestrateLaunchLock();
  const sessionHandler = createSessionHandler(sessionManager);
  const compactButtonHandler = createCompactButtonHandler(sessionManager);
  // Issue #412: tap-to-answer components for AskUserQuestion. The relay
  // functions are injected so the handler stays testable without a live server.
  const askComponentHandler = createAskComponentHandler({
    hasPendingAsk,
    resolveAskUser,
  });
  // Issue #449: `/brief` のタップ決裁ボタン。押した人は access.json（allowFrom）で
  // 認可され、実行コマンドは CHANNEL_MAP の `brief` 設定を持つチャンネルに限る
  // （fail-closed）。
  const briefDecisionHandler = createBriefDecisionHandler({
    resolveChannel: (_channelId, channelName) => {
      const config = CHANNEL_MAP.get(channelName);
      if (!config?.brief) return null;
      return {
        channelName: config.channelName,
        cwd: config.dir,
        decideArgs: config.brief.decideArgs,
      };
    },
  });

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
  const handleClientReady = async (readyClient: Client<true>) => {
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
    goalWatcher.start();
    orphanDispatchReaper.start();
    dispatchHealthReaper.start();
    activityWatchdog.start();
    resourceMonitor.start();

    // Issue #370 A-2: warn (never fail) about supervisor relay hooks that
    // exist on disk but are not wired into ~/.claude/settings.json.
    // ask-user-relay.sh sat unwired for months because nothing checked this.
    //
    // PR #431 review, should-5: console.error alone does not reach anybody.
    // supervisor.stderr.log is ~1.4MB and dominated by a per-30s ResourceMonitor
    // line, so a once-per-startup warning is buried on arrival — the same
    // "logged but unread" failure #422 was about. These warnings are only useful
    // if a human edits settings.json, so also post them where a human looks.
    const hookWarnings = checkHookWiring();
    for (const warning of hookWarnings) {
      console.error(warning);
    }
    if (hookWarnings.length > 0) {
      const hijoguchiId = claudeHubExitPrimaryChannelId();
      if (!hijoguchiId) {
        // Not silent: say that the escalation path itself is missing, rather
        // than letting the warning quietly stay log-only.
        console.error(
          "[HookWiring] HIJOGUCHI_CHANNEL_ID が未設定のため、上記の警告はログにしか出せません。",
        );
      } else {
        void (async () => {
          try {
            const channel = await client.channels.fetch(hijoguchiId);
            if (!channel?.isTextBased() || !("send" in channel)) return;
            const alert = formatHookWiringAlert(hookWarnings);
            if (alert) await channel.send(alert);
          } catch (err) {
            console.error("[HookWiring] Discord への警告投稿に失敗:", err);
          }
        })();
      }
    }

    // Register progress callback to send tool progress to Discord threads.
    // Events are buffered (Issue #119) and flushed every 2s as a single
    // message per thread to stay under Discord's 5-msg/5-sec rate limit.
    const handleProgress: ReadyWiringHandlers["relay:progress"] = (event) => {
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
    };

    // Issue #78 (AC-4): back the read-only GET /health/sessions endpoint with a
    // live snapshot of the manager's in-memory sessions so an E2E harness can
    // verify the thread → tmux session mapping without host access.
    const handleSessionsQuery: ReadyWiringHandlers["relay:sessionsQuery"] = () =>
      sessionManager.sessionsHealth();

    // Issue #370: forward AskUserQuestion prompts (POSTed by
    // hooks/ask-user-relay.sh to /ask/:threadId) to the Discord thread. Without
    // this subscriber the endpoint fast-fails 503 and the question never leaves
    // the TUI — the user saw a silent 19-minute block. The next user message in
    // the thread resolves the ask (see the messageCreate handler).
    const handleAskUser: ReadyWiringHandlers["relay:askUser"] = (event) => {
      void (async () => {
        try {
          const channel = await client.channels.fetch(event.threadId);
          if (!channel?.isThread()) return;
          // Issue #412: the post now carries buttons (or a select) so the
          // question can be answered with a tap. Text replies still resolve the
          // ask via hasPendingAsk in messageCreate — components are an added
          // path, not a replacement.
          //
          // Issue #416: the deadline is not restated here. buildAskPrompt ends
          // the post with the relay server's own askWaitNotice(timeoutMs), so
          // the wait budget has exactly one owner — the old hardcoded "約 5 分"
          // outlived two changes to the actual value.
          //
          // multiSelect is read defensively: single-question AskUserEvents do
          // not carry the flag (the hook flattens options to `label —
          // description` strings and drops it). Reading it now means the
          // select path switches on by itself once the payload grows the
          // field.
          const multiSelect =
            (event as { multiSelect?: unknown }).multiSelect === true;
          // Issue #443: 2+ questions arrive as `event.questions` (each with
          // its own options) — post one ActionRow per question instead of the
          // single flattened prompt below. The hook only populates this field
          // for a genuinely multi-question ask, so a solo ask still takes the
          // unchanged path.
          //
          // Issue #447: after (and only after) the question landed in the
          // thread, surface its existence in the parent channel with one
          // tappable link — a failed question post must never leave a dangling
          // "決裁待ち" notice pointing at nothing. notifyAskParentChannel is
          // best-effort inside (its own try/catch), so a notice failure never
          // reads as an ask failure: the question is already answerable.
          if (event.questions && event.questions.length > 1) {
            await postMultiAskUserPrompt(channel, {
              threadId: event.threadId,
              questions: event.questions,
              timeoutMs: event.timeoutMs,
            });
            await notifyAskParentChannel(
              client,
              channel,
              event.questions.length,
            );
            return;
          }
          // Issue #436 V-2: build + send is `postAskUserPrompt` (not inlined
          // here) so an E2E test can drive this exact call with a fake channel
          // and assert on what actually reaches `send()`, not just on
          // `buildAskPrompt`'s return value.
          await postAskUserPrompt(channel, {
            threadId: event.threadId,
            question: event.question,
            options: event.options,
            multiSelect,
            timeoutMs: event.timeoutMs,
          });
          await notifyAskParentChannel(client, channel, 1);
        } catch (err) {
          console.error(
            `[Bot] Failed to post AskUserQuestion to thread ${event.threadId}:`,
            err
          );
        }
      })();
    };

    // Issue #416 (Journey AC #3): the ask expired unanswered. Say so in the
    // thread — otherwise the question posted above stays on screen looking live
    // while the session has already fallen back to the TUI dialog, and the user
    // answers into a void. Also states that nothing was auto-selected (#423).
    const handleAskExpired: ReadyWiringHandlers["relay:askExpired"] = (
      event,
    ) => {
      // PR #431 review, should-3. The reapers spare a session only while the ask
      // is pending, and `lastActivityAt` was last touched BEFORE the question —
      // so at expiry the session is already ~5h "silent" and the 2h dispatch
      // health horizon is long past. Without this, the notice below invites the
      // user to attach and answer while the next reaper scan is about to remove
      // the session and its worktree. Restart the clock at the moment we hand
      // the decision back to the human. Done before the post so a Discord
      // failure cannot cost the reprieve.
      sessionManager.touchActivity(event.threadId);

      void (async () => {
        try {
          const channel = await client.channels.fetch(event.threadId);
          if (!channel?.isThread()) return;
          await channel.send(
            askExpiredNotice(event.timeoutMs, event.question),
          );
        } catch (err) {
          console.error(
            `[Bot] Failed to post ask expiry to thread ${event.threadId}:`,
            err,
          );
        }
      })();
    };

    // Register late-response callback: when a Stop hook POST arrives after
    // the initial relay already resolved (e.g. Monitor/background-task split
    // a single user turn into multiple assistant turns), forward the follow-up
    // text directly to the Discord thread so it isn't dropped.
    const handleLateResponse: ReadyWiringHandlers["relay:lateResponse"] = async (
      event,
    ) => {
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
          // Issue #206/#244: self-heal on the late-response path too (shares the
          // per-session tracker + healer, so de-dup and the cap hold across both
          // paths). The manager decides; deliverSelfHealOutcome posts the message
          // and drives the resume-backed restart when chosen.
          const outcome = await sessionManager.contextBudgetSelfHeal(
            event.threadId,
            event.contextTokens
          );
          if (outcome) {
            await deliverSelfHealOutcome(outcome, {
              thread: channel,
              threadId: event.threadId,
              sessionManager,
              client,
            });
          }
        } catch (budgetErr) {
          console.warn(
            `[Bot] context-budget self-heal failed (late) for thread ${event.threadId}:`,
            budgetErr
          );
        }
      } catch (err) {
        console.error(`[Bot] Late response send error for thread ${event.threadId}:`, err);
      }
    };

    // Epic #316 Phase 3 (#320, ADR-002 D5): claude-hub work セッション経路。
    // relay サーバの `POST /hub-work`（loopback-only、session-ctl
    // start-hub-worker が叩く）を runHubWork へ結線する。config は
    // CHANNEL_MAP.get() を通らない ephemeral なもの（runHubWork 内で組み立て、
    // CHANNEL_MAP へは登録しない）。ワーカースレッドは corp チャンネル配下
    // （D5-3）。キュー / admission / executor は既存 /dispatch と同一機構。
    const handleHubWork: ReadyWiringHandlers["relay:hubWork"] = async (body) =>
      runHubWork({
        body,
        sessionManager,
        queue: dispatchQueue,
        admissionGate: async () => {
          await admissionController.gate();
        },
        executorMode: resolveExecutorMode(),
        createThread: async (threadName) => {
          // corp チャンネル（work スレッドの親）をギルド横断で名前解決する。
          // 既存 dispatch は受信 message からチャンネルを得るが、HTTP 起動には
          // message が無いので cache から引く。
          let parent: TextChannel | null = null;
          for (const [, guild] of readyClient.guilds.cache) {
            const ch = guild.channels.cache.find(
              (c) =>
                c.name === HUB_WORK_PARENT_CHANNEL &&
                c.isTextBased() &&
                !c.isThread() &&
                "threads" in c,
            );
            if (ch) {
              parent = ch as TextChannel;
              // 複数ギルド参加時の追跡性（PR #325 gemini medium）: どのギルドの
              // #corp を選んだかをログに残す（cache の列挙順は保証されないため）。
              console.log(
                `[HubWork] resolved #${HUB_WORK_PARENT_CHANNEL} in guild ${guild.name} (${guild.id})`,
              );
              break;
            }
          }
          if (!parent) {
            throw new Error(
              `work スレッドの親チャンネル (#${HUB_WORK_PARENT_CHANNEL}) が見つかりません`,
            );
          }
          const created = await parent.threads.create({
            name: threadName,
            autoArchiveDuration: 10080, // 7 days（既存 dispatch と同じ）
          });
          return { id: created.id };
        },
        postToThread: async (tId, content) => {
          const thread = await client.channels.fetch(tId);
          if (thread?.isThread()) {
            await thread.send(content);
          }
        },
      });

    // Issue #339: オーケストレーターの進捗・最終レポートをスレッドの**親
    // チャンネル直下**へ投稿する経路（POST /channel-post/:threadId →
    // session-ctl post-channel が叩く）。投稿先は threadId から解決した親
    // チャンネルに構造的に限定される（任意チャンネル ID を受け取らない）。
    const handleChannelPost: ReadyWiringHandlers["relay:channelPost"] = async (
      threadId,
      text,
    ) => {
      let thread;
      try {
        thread = await client.channels.fetch(threadId);
      } catch (err) {
        // Unknown Channel 等の Discord API エラーは呼び出し側の指定ミス扱い。
        return {
          ok: false,
          status: 404,
          error: `スレッドを取得できません: ${threadId} (${err instanceof Error ? err.message : String(err)})`,
        };
      }
      if (!thread?.isThread()) {
        return {
          ok: false,
          status: 404,
          error: `スレッドではありません: ${threadId}`,
        };
      }
      // thread.parent はキャッシュ依存のゲッターで、起動直後などキャッシュ外
      // だと実在する親でも null を返す（PR #340 gemini high）。parentId からの
      // 明示 fetch にフォールバックする。
      let parent: Channel | null = thread.parent;
      if (!parent && thread.parentId) {
        try {
          parent = await client.channels.fetch(thread.parentId);
        } catch {
          // fetch 失敗は下の null チェックで 404 に落とす。
        }
      }
      if (!parent || !parent.isTextBased() || parent.isDMBased()) {
        return {
          ok: false,
          status: 404,
          error: `親チャンネルを解決できません: ${threadId}`,
        };
      }
      // 長文（Mermaid 含む最終レポート）は relay 本文と同じ整形で分割送信する。
      const chunks = formatForDiscord(text).filter((c) => c.trim());
      // 途中 chunk の send 失敗時は送信済み件数をエラーに含め、呼び出し元
      // （session-ctl post-channel / オーケストレーター）が再試行時の重複投稿
      // リスクを判断できるようにする（PR #340 coderabbit major）。
      let sentCount = 0;
      try {
        for (const chunk of chunks) {
          await parent.send(chunk);
          sentCount++;
        }
      } catch (err) {
        return {
          ok: false,
          status: 502,
          error:
            `送信中にエラー（${sentCount}/${chunks.length} chunks 送信済み。` +
            `再試行すると重複投稿の可能性があります）: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      console.log(
        `[Bot] channel-post: thread ${threadId} → #${parent.name} (${chunks.length} chunks, ${text.length} chars)`,
      );
      return { ok: true, channelId: parent.id, chunks: chunks.length };
    };

    // Issue #383: apply the ready-time relay wiring in one place. Registering
    // here (not at boot) is deliberate — see READY_WIRING_IDS in bot-wiring.ts.
    wireReady(wiringSurface, {
      "relay:progress": handleProgress,
      "relay:sessionsQuery": handleSessionsQuery,
      "relay:askUser": handleAskUser,
      "relay:askExpired": handleAskExpired,
      "relay:lateResponse": handleLateResponse,
      "relay:hubWork": handleHubWork,
      "relay:channelPost": handleChannelPost,
    });
  };

  // Safe reply helper: never throws. Used in error paths where the interaction may
  // already be stale (Mac sleep/wake can expire the 3-second initial-response token).
  async function safeReplyError(
    interaction: Interaction,
    err: unknown
  ): Promise<void> {
    // Repliable (not just chat-input): button interactions share this path since
    // #364, and narrowing to slash commands would silently swallow their errors.
    if (!interaction.isRepliable()) return;
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

  // Handle slash commands + message components
  const handleInteractionCreate = (interaction: Interaction): void => {
    // #412: AskUserQuestion answer components. Checked before the compact
    // branch because this is the only branch that also accepts a String Select
    // — a select interaction is not a button, so it would otherwise fall
    // through to the chat-input guard and be dropped.
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      if (isAskComponentId(interaction.customId)) {
        askComponentHandler(interaction).catch(async (err) => {
          console.error("[Bot] Ask component error:", err);
          await safeReplyError(interaction, err);
        });
        return;
      }
    }
    // #449: `/brief` タップ決裁ボタン。ask 系と同じく customId prefix で振り分け、
    // 認可・実行はハンドラ側が持つ。
    if (interaction.isButton() && isBriefDecisionComponentId(interaction.customId)) {
      briefDecisionHandler(interaction).catch(async (err) => {
        console.error("[Bot] Brief decision component error:", err);
        await safeReplyError(interaction, err);
      });
      return;
    }
    // #364: the one-click compact button. Component interactions are routed by
    // customId to the app that sent the message, so unlike a top-level
    // `/compact` slash command this can never be captured by another bot.
    if (interaction.isButton()) {
      if (interaction.customId !== COMPACT_BUTTON_ID) return;
      compactButtonHandler(interaction).catch(async (err) => {
        console.error("[Bot] Compact button error:", err);
        await safeReplyError(interaction, err);
      });
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "session") return;

    // Explicit .catch() ensures the async chain can never leak an unhandled rejection.
    sessionHandler(interaction).catch(async (err) => {
      console.error("[Bot] Command error:", err);
      await safeReplyError(interaction, err);
    });
  };

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
    // Epic #285 Phase 2: headless is opt-in via DISPATCH_EXECUTOR_MODE=headless.
    // Default (unset) keeps the current tmux path unchanged.
    const executorMode = resolveExecutorMode();

    const postToThread = async (tId: string, content: string): Promise<void> => {
      const thread = await client.channels.fetch(tId);
      if (thread?.isThread()) {
        await thread.send(content);
      }
    };

    // Phase 5c (#294): the thread is created EAGERLY (before the concurrency
    // decision) so a queued dispatch can be told it is waiting, in its own thread.
    // Sequence suffix mirrors handleStart / RW-046 same-branch multi-session.
    let dispatchThread: { id: string };
    try {
      const sameBranchCount = sessionManager
        .listRunningByChannel(channelName)
        .filter((s) => s.branch === branch).length;
      const threadName = buildThreadTitle(
        "running",
        branch,
        config.displayName,
        sameBranchCount + 1
      );
      const created = await textChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080, // 7 days
      });
      dispatchThread = { id: created.id };
    } catch (err) {
      console.error(
        `[Bot] Dispatch thread creation failed in channel ${channelName}:`,
        err
      );
      return true;
    }

    // Runs the actual dispatch once a concurrency slot is granted. Returns whether
    // a session actually started (the queue holds the slot until the session ends
    // when true; frees it immediately when false).
    const runOnce = async (): Promise<boolean> => {
      // Phase 5d (#295): WARN-first admission. Observe mode (default) only logs a
      // WARN under high load; enforce mode delays the start.
      await admissionController.gate();
      const result = await runDispatch({
        config,
        branch,
        issueNumber,
        command,
        sessionManager,
        executorMode,
        postToThread,
        createThread: async () => dispatchThread, // reuse the eagerly-created thread
      });

      if (result.ok && result.mode === "tmux") {
        try {
          await postToThread(
            result.threadId,
            `🛰️ **${config.displayName}** をディスパッチで起動しました\n\n` +
              `🌿 ブランチ: \`${branch}\`\n` +
              `▶️ 初期コマンド: \`${result.injected}\`\n` +
              `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}`
          );
        } catch (err) {
          console.error(
            `[Bot] Dispatch welcome message failed for thread ${result.threadId}:`,
            err
          );
        }
      } else if (result.ok) {
        console.log(
          `[Bot] Headless dispatch completed in channel ${channelName} (thread=${result.threadId}, exit=${result.exitCode}, timedOut=${result.timedOut})`
        );
      } else {
        console.error(
          `[Bot] Dispatch failed (stage=${result.stage}) in channel ${channelName}: ${result.error}`
        );
        // Issue #429: the log alone left corp (and the user) with no signal at
        // all — the ledger stays `dispatched` and the thread shows nothing, so a
        // dispatch that never reached the pane is indistinguishable from one
        // that is merely still working. Posting into the thread is what makes it
        // recoverable: corp's failed-re-injection path (corp#107 / #108) only
        // needs the failure to be visible.
        try {
          await postToThread(
            dispatchThread.id,
            buildDispatchFailureNotice(
              result.stage,
              config.displayName,
              branch,
              issueNumber,
              command,
              { sessionStopped: result.sessionStopped }
            )
          );
        } catch (err) {
          console.error(
            `[Bot] Dispatch failure notice could not be posted to thread ${dispatchThread.id}:`,
            err
          );
        }
      }
      return result.ok;
    };

    // Phase 5c (#294): submit to the concurrency-limited FIFO queue. Under the
    // limit it starts now; over the limit it is queued (not rejected) and the
    // thread is told its position.
    await dispatchQueue.submit({
      key: dispatchThread.id,
      run: runOnce,
      onQueued: async (position) => {
        await postToThread(
          dispatchThread.id,
          `⏳ 同時実行の上限（${dispatchQueue.limit()}）に達しているため待機中です（キュー ${position} 番目）。` +
            `先行 dispatch の完了後、FIFO で自動起動します。`
        );
      },
      onDequeued: async () => {
        await postToThread(
          dispatchThread.id,
          `▶️ 空きが出たため、キューから起動します。`
        );
      },
    });
    return true;
  }

  // Epic #316 Phase 1 (#318): handle an `/orchestrate <生引数...>` message in a
  // known department channel — start ONE orchestrator session (tmux + thread)
  // and inject `/orchestrate-runner <生引数>` as its first prompt. Placed
  // alongside handleDispatchMessage (same intercept shape) but authorized via
  // the normal-message gate (`evaluateAccess` / access.json `allowFrom`,
  // fail-closed), NOT the dispatch-source policy. Returns true when the message
  // was an orchestrate attempt and was fully handled (caller must stop), false
  // when it is not an orchestrate and normal processing should continue.
  //
  // Per ADR-002 D2 the Supervisor's responsibility ends here: argument
  // interpretation, worker dispatching, monitoring and merge decisions all
  // live in the orchestrator skill (Phase 2 #319). The raw arguments are never
  // parsed — they travel through the relay's argv-no-shell injection path
  // (sendMessage → tmux send-keys -l) untouched.
  async function handleOrchestrateMessage(message: Message): Promise<boolean> {
    // Orchestrate only applies to a non-thread message in a known department
    // channel whose text starts with the orchestrate token.
    if (message.channel.isThread()) return false;
    const content = message.content ?? "";
    const trimmed = content.trim();
    if (
      trimmed !== ORCHESTRATE_PREFIX &&
      !trimmed.startsWith(ORCHESTRATE_PREFIX + " ") &&
      !trimmed.startsWith(ORCHESTRATE_PREFIX + "\n")
    ) {
      return false;
    }

    const channelName =
      "name" in message.channel ? (message.channel.name as string) : "";
    const config = CHANNEL_MAP.get(channelName);
    if (!config) {
      // Unknown channel: not a valid orchestrate target — fall through to
      // normal processing (non-thread messages are ignored there anyway).
      return false;
    }
    const textChannel = message.channel as TextChannel;

    // Authorize the sender with the SAME gate as normal relay messages
    // (access.json `allowFrom` keyed on the channel id). Fail-closed: a
    // missing / broken policy or an unlisted sender denies. Independent of
    // the dispatch-only `dispatchFrom` list (#318).
    {
      const botUserId = client.user?.id;
      const isMention = botUserId
        ? message.mentions.users.has(botUserId)
        : false;
      const decision = evaluateAccess({
        channelKey: textChannel.id,
        userId: message.author.id,
        isMention,
      });
      if (!decision.allowed) {
        // Identifier-free denial log; never log the sender snowflake or body.
        console.warn(
          `[Bot] Orchestrate denied (reason=${decision.reason}) in channel ${channelName}; not started`
        );
        // Consume the message: by here it is an `/orchestrate` in a known
        // department channel, which the normal relay path never acts on.
        return true;
      }
    }

    const parsed = parseOrchestrateCommand(content);
    if (parsed.kind === "not_orchestrate") {
      return false;
    }
    if (parsed.kind === "error") {
      console.warn(
        `[Bot] Orchestrate rejected in channel ${channelName}: ${parsed.reason}`
      );
      try {
        await textChannel.send(`⚠️ ${parsed.reason}`);
      } catch (err) {
        console.error(
          `[Bot] Orchestrate rejection notice failed in channel ${channelName}:`,
          err
        );
      }
      return true;
    }

    // In-flight lock (PR #324 review): acquired SYNCHRONOUSLY (no await between
    // the running-session guard below and the lock) so two rapid /orchestrate
    // messages cannot both pass the guard while the first launch is still
    // creating its thread / starting its session (TOCTOU). Released in finally
    // once the launch settles (success or failure) — from then on the
    // running-session guard takes over because the session is registered.
    if (!orchestrateLaunchLock.tryAcquire(channelName)) {
      try {
        await textChannel.send(
          `⏳ このチャンネルでオーケストレーターの起動処理が進行中です。完了後に再試行してください。`
        );
      } catch (err) {
        console.error(
          `[Bot] Orchestrate in-flight notice failed in channel ${channelName}:`,
          err
        );
      }
      return true;
    }
    try {
      // Duplicate-launch guard (#318): one orchestrator per channel. When one
      // is already running (branch prefix `orchestrate-`), answer with its
      // thread link instead of starting a second — unless the user explicitly
      // passed `--new`.
      const running = findRunningOrchestrator(
        sessionManager.listRunningByChannel(channelName)
      );
      if (running && !parsed.forceNew) {
        try {
          await textChannel.send(
            `ℹ️ このチャンネルでは既にオーケストレーターが稼働中です: <#${running.threadId}>\n` +
              `稼働中のスレッドに追加指示を送るか、別のオーケストレーターが必要な場合は ` +
              `\`/orchestrate --new <タスク...>\` で明示起動してください。`
          );
        } catch (err) {
          console.error(
            `[Bot] Orchestrate duplicate-guard notice failed in channel ${channelName}:`,
            err
          );
        }
        return true;
      }

      const branch = orchestrateBranchName();
      console.log(
        `[Bot] Orchestrate accepted in channel ${channelName} (branch=${branch}, args len=${parsed.rawArgs.length}, forceNew=${parsed.forceNew})`
      );

      // Thread creation mirrors handleDispatchMessage (sequence suffix per
      // RW-046 same-branch multi-session).
      let orchestrateThread: { id: string };
      try {
        const sameBranchCount = sessionManager
          .listRunningByChannel(channelName)
          .filter((s) => s.branch === branch).length;
        const threadName = buildThreadTitle(
          "running",
          branch,
          config.displayName,
          sameBranchCount + 1
        );
        const created = await textChannel.threads.create({
          name: threadName,
          autoArchiveDuration: 10080, // 7 days
        });
        orchestrateThread = { id: created.id };
      } catch (err) {
        console.error(
          `[Bot] Orchestrate thread creation failed in channel ${channelName}:`,
          err
        );
        return true;
      }

      const result = await runOrchestrate({
        config,
        branch,
        rawArgs: parsed.rawArgs,
        sessionManager,
        createThread: async () => orchestrateThread, // reuse the created thread
      });

      if (result.ok) {
        try {
          const thread = await client.channels.fetch(result.threadId);
          if (thread?.isThread()) {
            // Echo the injected command (arguments included) so the thread's
            // first message confirms what the orchestrator received (統合
            // ジャーニーAC 1). Truncated to stay well under Discord's 2000-char
            // message limit alongside the surrounding text.
            const echo =
              result.injected.length > 1500
                ? `${result.injected.slice(0, 1500)}…`
                : result.injected;
            await thread.send(
              `🎼 **${config.displayName}** のオーケストレーターを起動しました\n\n` +
                `🌿 ブランチ: \`${branch}\`\n` +
                `▶️ 初期コマンド: \`${echo}\`\n` +
                `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}`
            );
          }
        } catch (err) {
          console.error(
            `[Bot] Orchestrate welcome message failed for thread ${result.threadId}:`,
            err
          );
        }
      } else {
        console.error(
          `[Bot] Orchestrate failed (stage=${result.stage}) in channel ${channelName}: ${result.error}`
        );
        try {
          await textChannel.send(
            `❌ オーケストレーターの起動に失敗しました（stage=${result.stage}）。Supervisor ログを確認してください。`
          );
        } catch (postErr) {
          console.error(
            `[Bot] Orchestrate failure notice failed in channel ${channelName}:`,
            postErr
          );
        }
      }
      return true;
    } finally {
      orchestrateLaunchLock.release(channelName);
    }
  }

  // Issue #426: the last brief injected per channel, for the (channel, date)
  // idempotency guard. In-memory on purpose: it only has to outlive corp's
  // delivery retries (minutes), and a Supervisor restart re-arming the trigger
  // is the safer failure direction than persisting a stale "already delivered".
  const recentBriefByChannel = new Map<string, RecentBrief>();

  // Issue #454: bind the real Discord channel / SessionManager into the window
  // adapters. Everything else — decisions, notices, logging — lives in
  // session/brief-window.ts so it stays under test; this is only the binding.
  const briefWindowDeps = (
    config: ChannelConfig,
    textChannel: TextChannel,
  ): BriefWindowDeps =>
    createBriefWindowDeps({
      channel: textChannel,
      sessions: {
        has: (threadId) => sessionManager.has(threadId),
        start: async (threadId, branch) => {
          await sessionManager.start(config, threadId, branch);
        },
        waitForInputReady: (threadId) =>
          sessionManager.waitForInputReady(threadId),
        // #464: 通常の会話経路と同じく chunks を持ち帰る。捨てると起動直後の
        // 待機報告がどこにも出ない（投稿するのは brief-window.ts 側）。
        sendMessage: async (threadId, text) => {
          const result = await sessionManager.sendMessage(threadId, text);
          return { chunks: result.chunks, error: result.error };
        },
      },
      fetchThread: async (threadId) => {
        const ch = await client.channels.fetch(threadId);
        return ch?.isThread() ? ch : null;
      },
      notifyFailure: async (title, body) => {
        await notifyPushover(title, body);
      },
    });

  // Issue #454 (lazy path): a message in a window thread whose session the idle
  // reaper already stopped restarts it instead of answering with the salvage
  // notice. Returns true when the message was consumed and the caller must stop.
  // Only the Discord-specific parent resolution lives here.
  async function tryRestartBriefWindow(
    message: Message,
    threadId: string,
  ): Promise<BriefWindowMessageOutcome> {
    const thread = message.channel as ThreadChannel;
    // Cheap early-out so an ordinary dead thread never fetches config or channels.
    if (parseBriefWindowThreadName(thread.name) === null) return "not_window";

    // thread.parent はキャッシュ依存のゲッターで、起動直後などキャッシュ外だと
    // 実在する親でも null を返す（PR #340 gemini high）。parentId からの明示
    // fetch にフォールバックしないと、supervisor 再起動直後の窓口だけ復帰しない。
    let parent = thread.parent as TextChannel | null;
    if (!parent && thread.parentId) {
      const fetched = await client.channels.fetch(thread.parentId);
      parent =
        fetched && !fetched.isThread() && fetched.isTextBased()
          ? (fetched as TextChannel)
          : null;
    }
    if (!parent) return "not_window";

    const parentName = "name" in parent ? (parent.name as string) : "";
    const config = CHANNEL_MAP.get(parentName);
    if (!config) return "not_window";

    return handleBriefWindowThreadMessage({
      threadId,
      threadName: thread.name,
      hasBriefConfig: Boolean(config.brief),
      sessionCount: sessionManager.count(),
      maxSessions: MAX_SESSIONS,
      deps: briefWindowDeps(config, parent),
    });
  }

  // Issue #426 → #449: handle a `/brief <YYYY-MM-DD>` message from an allowed
  // external source (corp's dispatch bot) — fetch the day's pending proposals
  // via the channel's configured CLI and post tap-to-decide buttons DIRECTLY in
  // the channel (corp#112 AC-1, session-less since #449). Returns true when the
  // message was a brief attempt and was fully handled (caller must stop), false
  // when it is not a brief and normal processing should continue.
  //
  // This is the second exception to the blanket `message.author.bot` drop, and
  // it is deliberately the SAME shape and the SAME authorization as
  // handleDispatchMessage (`isDispatchSourceAllowed`, fail-closed) — a new
  // authorization model would be a new way to get it wrong. Two things make it
  // strictly weaker than dispatch, by design:
  //   - it starts no session and injects into none (#449 removed the injection
  //     capability entirely — the decision runs through a deterministic CLI);
  //   - it accepts no caller text. The single external input is a `YYYY-MM-DD`
  //     token; what gets executed is fixed argv from CHANNEL_MAP's `brief`
  //     config. That is what stops this path from becoming a way to hand the
  //     HQ arbitrary instructions and bypass the approval gate.
  async function handleBriefMessage(message: Message): Promise<boolean> {
    // Same entry shape as dispatch: a non-thread message in a known channel
    // whose text starts with the trigger token.
    if (message.channel.isThread()) return false;
    const content = message.content ?? "";
    if (!isBriefCommand(content)) return false;

    const channelName =
      "name" in message.channel ? (message.channel.name as string) : "";
    const config = CHANNEL_MAP.get(channelName);
    if (!config) {
      // Unknown channel: not a valid brief target. Treat as "not handled" so a
      // non-bot author still flows through normal processing; a bot author is
      // dropped by the caller's bot guard.
      return false;
    }

    // All of the decision logic (kill-switch → authorization → parse →
    // idempotency → target resolution → ask guard, in that order) lives in the
    // pure evaluator so it is testable without a gateway or a real
    // SessionManager. Only the side effects are here.
    const decision = evaluateBriefTrigger({
      content,
      channelId: message.channel.id,
      sourceId: message.author.id,
      policy: loadAccessPolicy(),
      recentBrief: recentBriefByChannel.get(channelName),
    });

    const textChannel = message.channel as TextChannel;
    const postToChannel = async (text: string): Promise<void> => {
      try {
        await textChannel.send(text);
      } catch (err) {
        console.error(
          `[Bot] Brief notice failed in channel ${channelName}:`,
          err
        );
      }
    };

    switch (decision.action) {
      case "ignore":
        return false;

      case "disabled":
        console.warn(
          `[Bot] Brief disabled by kill-switch (${BRIEF_DISABLED_ENV}) in channel ${channelName}; not injected`
        );
        // The kill-switch is a deliberate operator action, but corp cannot see
        // this Supervisor's env — from its side the post would just vanish.
        // Same "never fail silently" bar as no_session / ambiguous, minus the
        // page (nothing is broken).
        await postToChannel(
          `🛑 朝レポの決裁依頼は kill-switch（\`${BRIEF_DISABLED_ENV}\`）で停止中のため実行しませんでした。`
        );
        return true;

      case "denied":
        // Identifier-free denial log; never log the source/channel snowflake or
        // the message body. Consume the message either way: by here it is a
        // `/brief` in a known channel, which the normal relay path never acts on.
        console.warn(
          `[Bot] Brief denied (reason=${decision.reason}) in channel ${channelName}; not injected`
        );
        return true;

      case "rejected":
        // The source is authorized but the command is malformed. `reason` is a
        // fixed literal from the parser (never echoed user text).
        console.warn(
          `[Bot] Brief rejected in channel ${channelName}: ${decision.reason}`
        );
        await postToChannel(`⚠️ ${decision.reason}`);
        return true;

      case "duplicate":
        // Idempotency: corp retrying its delivery (or a manual re-post) must not
        // interrupt the running conversation twice for the same day. Not a
        // failure — the brief WAS delivered — so it is logged and posted but
        // never paged.
        console.log(
          `[Bot] Brief already delivered in channel ${channelName} (date=${decision.date}, ${Math.round(decision.elapsedMs / 1000)}s ago); not injected again`
        );
        await postToChannel(
          `ℹ️ 朝レポ（${decision.date}）の決裁依頼は既に実行済みのため、二重の割り込みを避けて見送りました。`
        );
        return true;

      case "decide": {
        // #449: セッションに触れず、ここで未決提案を取得してチャンネル直下に
        // 決裁ボタンを post する（会長決裁・案 A）。セッション不在 / 複数 /
        // 回答待ちという #426 の失敗クラス（no_session / ambiguous / deferred）
        // はこの経路には存在しない。
        if (!config.brief) {
          // CHANNEL_MAP に brief CLI が未設定のチャンネル。fail-closed だが
          // silent にしない（corp 側からは post が消えたように見えるため）。
          console.warn(
            `[Bot] Brief received but channel ${channelName} has no brief CLI config; not executed`
          );
          await postToChannel(
            `⚠️ 朝レポ（${decision.date}）の着信を受けましたが、このチャンネルには brief 決裁の実行設定がありません（決裁は未実行）。`
          );
          return true;
        }
        console.log(
          `[Bot] Brief accepted in channel ${channelName} (date=${decision.date}); fetching pending proposals`
        );
        // 一連（取得 → パース → post）は runBriefDecideFlow が持ち、失敗報告の
        // 義務ごと単体テストで固定されている。delivered のときだけ同日 dedup を
        // 記録する（失敗時は記録せず、同じ日付の再送で回復できる余地を残す）。
        const delivered = await runBriefDecideFlow({
          date: decision.date,
          channelName,
          cwd: config.dir,
          proposalsArgs: config.brief.proposalsArgs,
          postToChannel,
          postDecisionMessage: async (msg) => {
            await textChannel.send({
              content: msg.content,
              components: msg.components,
            });
          },
          notifyFailure: async (title, body) => {
            await notifyPushover(title, body);
          },
        });
        if (delivered) {
          recentBriefByChannel.set(channelName, {
            date: decision.date,
            atMs: Date.now(),
          });
        }

        // Issue #454: open the day's conversation window ALONGSIDE the buttons.
        // A channel-level message reaches no session (see the isThread guard in
        // handleMessageCreate), so a thread is the only place the chairman can
        // answer with anything other than approve / reject / hold. Deliberately
        // not gated on `delivered`: the morning the decision post fails is
        // exactly when a way to talk matters most. openBriefWindowForBrief
        // reports and swallows its own failures so the buttons never go down
        // with the window.
        await openBriefWindowForBrief({
          date: decision.date,
          channelName,
          sessionCount: sessionManager.count(),
          maxSessions: MAX_SESSIONS,
          deps: briefWindowDeps(config, textChannel),
        });

        return true;
      }
    }
  }

  // Message relay: thread messages → Claude Code → thread reply
  const handleMessageCreate = async (message: Message): Promise<void> => {
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

    // Epic #316 Phase 1 (#318): intercept `/orchestrate` in a known department
    // channel BEFORE the blanket bot/webhook drop below (same shape as the
    // dispatch intercept). Fail-closed inside handleOrchestrateMessage via
    // evaluateAccess (access.json `allowFrom`).
    try {
      if (await handleOrchestrateMessage(message)) return;
    } catch (err) {
      console.error("[Bot] Orchestrate handler error:", err);
      return;
    }

    // Issue #426: intercept `/brief` from an allowed external source BEFORE the
    // blanket bot/webhook drop below (same shape as the dispatch intercept).
    // Without this, corp's morning brief can never reach the CEO session and
    // corp#112's AC-1 (tap-to-decide) has no trigger. Fail-closed inside
    // handleBriefMessage via isDispatchSourceAllowed (access.json `dispatchFrom`).
    try {
      if (await handleBriefMessage(message)) return;
    } catch (err) {
      console.error("[Bot] Brief handler error:", err);
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
    //
    // Issue #456: before falling back to that guidance, treat the message
    // itself as a wake trigger. A thread whose session was stopped (supervisor
    // restart, dispatch-health reap, idle reap) still owns its history in
    // sessions.db, so resume it INTO THIS THREAD and relay the message that
    // woke it. Only threads with history do this — an unknown thread must never
    // auto-start a session (AC-2) — and a failed resume is reported, not
    // swallowed (AC-3). Access was already enforced above, so a channel whose
    // policy sets requireMention still only wakes on a mention.
    if (!sessionManager.has(threadId)) {
      // Issue #454: the morning window is meant to stay usable all day, but the
      // interactive idle reaper (6h) legitimately stops it. Restart it on the
      // chairman's next message instead of answering with a salvage notice —
      // access was already enforced above, so this is the same privilege a
      // `/session start` in this thread would take. Non-window threads fall
      // through unchanged.
      //
      // This stays AHEAD of the #456 generic wake below on purpose. A window
      // thread has history too, so a plain `--resume` would match it first and
      // silently retire #454's contract: re-injecting `/brief-window <date>`
      // and telling the chairman to resend instead of relaying into a TUI that
      // is still booting (RW-025 / RW-047). The name check inside is a cheap
      // early-out, so ordinary threads reach the wake path unchanged.
      try {
        // #463: "not_window" 以外＝窓口スレッドと判定できた場合は、起動できた
        // かどうかに関わらずここで終える。下の汎用 wake（#456）に落とすと素の
        // --resume が先に噛み、kill-switch で止めたはずの窓口が起き上がる。
        if ((await tryRestartBriefWindow(message, threadId)) !== "not_window") {
          return;
        }
      } catch (err) {
        console.error("[Bot] Brief window restart error:", err);
      }

      const wake = await autoResumeThread(sessionManager, threadId);
      const botUserId = client.user?.id;
      const { relay, reply } = await resolveWakeReply(wake, {
        mentioned: botUserId ? message.mentions.users.has(botUserId) : false,
        buildSalvage: (verdict) =>
          buildSalvageReply(sessionManager, threadId, verdict),
      });

      if (reply) {
        try {
          await (message.channel as ThreadChannel).send(reply);
        } catch (err) {
          // On the resume path the session IS live, so losing the courtesy
          // notice must not cost the user their message — fall through to the
          // relay either way.
          console.error(
            `[Bot] Failed to reply in thread ${threadId}:`,
            err
          );
        }
      }

      if (!relay) {
        if (!reply) {
          console.debug(
            `[Bot] Ignoring message in thread ${threadId} (no active session, wake=${wake.kind})`
          );
        }
        return;
      }
      // Fall through: the relay below now finds the resumed session.
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
            await thread.send(await buildStatusReply(sessionManager, threadId));
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

    // Issue #370: a pending AskUserQuestion consumes the next user message in
    // this thread as its answer. The session is blocked inside the PreToolUse
    // hook waiting on POST /ask — relaying the reply into tmux would type it
    // into a TUI that is not accepting input, so resolve the ask and stop.
    if (hasPendingAsk(threadId)) {
      // Issue #443 AC-3: a multi-question ask is answered by tapping each
      // question's own row, not by one free-text reply — resolveAskUser below
      // would otherwise hand Claude a stray, unrelated message as "the answer
      // to every question in the batch" (the #443 incident). The remaining
      // questions stay live for tapping; nothing here resolves the ask.
      if (hasActiveMultiAsk(threadId)) {
        try {
          await message.reply(
            "この質問は複数あります。上のボタン/メニューからそれぞれタップして回答してください（テキストでの一括回答はできません）。"
          );
        } catch {
          // Best-effort notice only; the ask itself stays pending either way.
        }
        return;
      }
      resolveAskUser(threadId, messageText);
      // The session was parked for up to 5h with no activity recorded (#416), so
      // its idle age is stale by the whole wait. Answering IS activity — record
      // it now rather than leaving the session one reaper scan from removal
      // while it resumes work.
      sessionManager.touchActivity(threadId);
      try {
        await message.react("✅");
      } catch {
        // Best-effort ack; delivering the answer is what matters.
      }
      return;
    }

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

      // Relay to Claude Code.
      // Issue #422: this line marks the START of the attempt, not a delivery —
      // the old "Relaying message" wording read as "relayed" and made a message
      // that never reached the pane look successfully handled in the log.
      // `[Relay] delivered to pane …` (relay.ts) is the delivery record.
      console.log(
        `[Bot] Relay start in thread ${threadId} (${messageText.length} chars, ${attachments.length} attachments)`
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
          // Issue #206/#244: self-heal — auto-compact on red (capped),
          // resume-backed restart on critical. The manager decides;
          // deliverSelfHealOutcome posts the message, drives the restart when
          // chosen, and pages Pushover on red/critical.
          const outcome = await sessionManager.contextBudgetSelfHeal(
            threadId,
            result.contextTokens
          );
          if (outcome) {
            await deliverSelfHealOutcome(outcome, {
              thread,
              threadId,
              sessionManager,
              client,
            });
          }
        } catch (budgetErr) {
          console.warn(
            `[Bot] context-budget self-heal failed for thread ${threadId}:`,
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
        // Issue #236: log the raw cause (object, so the stack survives) but post
        // only the canned notice — `err.message` can embed absolute paths and
        // `String(err)` anything at all. Same split as #74's send-keys path.
        console.error(`[Bot] Relay error in thread ${threadId}:`, err);
        try {
          await thread.send(RELAY_ERROR_USER_MESSAGE);
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
  };

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Bot] Shutdown signal received");
    stopActionReceiver();
    reaper.stop();
    goalWatcher.stop();
    orphanDispatchReaper.stop();
    dispatchHealthReaper.stop();
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

  // Issue #383: the single boot-time wiring application. Every handler above is
  // defined by now, and nothing can fire before client.login() below, so
  // applying the whole map here is equivalent to the previous scattered
  // client.on / process.on calls — with the map itself now assertable in tests.
  wireBoot(wiringSurface, {
    "sessionManager:sessionEnd": handleSessionEnd,
    "client:ClientReady": handleClientReady,
    "client:InteractionCreate": handleInteractionCreate,
    "client:MessageCreate": handleMessageCreate,
    "process:SIGTERM": shutdown,
    "process:SIGINT": shutdown,
  });

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
