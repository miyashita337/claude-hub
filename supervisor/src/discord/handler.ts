// IDiscordClient → SessionManager wiring (Issue #144 Phase 2).
//
// Captures the message-routing core that bot.ts performs (slash command →
// SessionManager.start/stop, thread message → SessionManager.sendMessage →
// reply via the client). Decoupled from discord.js so the lifecycle E2E
// test can swap in InMemoryDiscordClient.
//
// Production bot.ts is unchanged in this PR. A follow-up will migrate
// bot.ts to call wireBotHandlers() with a RealDiscordClient so the
// production path and the test path share the same handler logic.
//
// TODO(#144 Phase 5): once bot.ts adopts wireBotHandlers, port over the
// reaction (⏳/✅/⚠️) and progress-buffer wiring from bot.ts so the test
// surface matches production. dispose() is a no-op today because
// IDiscordClient lacks unsubscribe; add `off(handler)` to the interface
// before wiring up multi-tenant reuse.

import type { ChannelConfig } from "../config/channels";
import type { SessionManager } from "../session/manager";
import type {
  DiscordSlashCommand,
  DiscordThreadMessage,
  IDiscordClient,
} from "./types";

export interface WireBotHandlersOptions {
  /** Resolve a channelName (from /session start) into a ChannelConfig. */
  resolveChannel: (channelName: string) => ChannelConfig | undefined;
  /**
   * Resolve threadId for a session-start interaction. The real bot.ts
   * creates a Discord thread and uses its ID; tests inject an explicit
   * threadId via this hook so they can control the value.
   */
  threadIdFor: (cmd: DiscordSlashCommand) => string;
  /**
   * Optional logger. Defaults to console; tests pass a recording sink.
   */
  log?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

export interface WireBotHandlersResult {
  /** Currently no-op; returned for forward compatibility (matches bot.ts cleanup style). */
  dispose(): void;
}

const DEFAULT_LOG = {
  info: (msg: string, ...args: unknown[]) => console.log(msg, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
};

/**
 * Wire up message routing. Returns a handle for symmetric tear-down.
 * Idempotent: handlers register exactly once per call.
 */
export function wireBotHandlers(
  client: IDiscordClient,
  sessionManager: SessionManager,
  options: WireBotHandlersOptions,
): WireBotHandlersResult {
  const log = options.log ?? DEFAULT_LOG;

  client.onSlashCommand((cmd) => {
    void handleSlash(cmd, client, sessionManager, options, log);
  });

  client.onThreadMessage((msg) => {
    void handleThreadMessage(msg, client, sessionManager, log);
  });

  return {
    dispose() {
      // IDiscordClient does not expose unsubscribe today. Tests that want
      // a fresh wiring should construct a new client instance.
    },
  };
}

type Logger = NonNullable<WireBotHandlersOptions["log"]>;

async function handleSlash(
  cmd: DiscordSlashCommand,
  client: IDiscordClient,
  sessionManager: SessionManager,
  options: WireBotHandlersOptions,
  log: Logger,
): Promise<void> {
  if (cmd.commandName !== "session") return;

  const sub = cmd.subcommand;
  try {
    if (sub === "start") {
      const channelName = String(cmd.options.channel ?? "");
      const config = options.resolveChannel(channelName);
      if (!config) {
        await cmd.reply(`❌ 未知のチャンネル: ${channelName}`, true);
        return;
      }
      const threadId = options.threadIdFor(cmd);
      sessionManager.start(config, threadId);
      log.info(`[handler] session started: ${channelName} (thread ${threadId})`);
      await cmd.reply(
        `✅ ${config.displayName} のセッションを開始しました (thread \`${threadId}\`)`,
      );
      return;
    }

    if (sub === "stop") {
      const threadId = options.threadIdFor(cmd);
      await sessionManager.stop(threadId, "manual");
      log.info(`[handler] session stopped: ${threadId}`);
      await cmd.reply(`🛑 セッションを停止しました (thread \`${threadId}\`)`);
      return;
    }

    await cmd.reply(`❓ 未知のサブコマンド: ${sub ?? "(none)"}`, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[handler] slash error: ${msg}`);
    try {
      await cmd.reply(`❌ エラー: ${msg.slice(0, 1900)}`, true);
    } catch (replyErr) {
      log.error(`[handler] reply also failed:`, replyErr);
    }
  }
}

async function handleThreadMessage(
  msg: DiscordThreadMessage,
  client: IDiscordClient,
  sessionManager: SessionManager,
  log: Logger,
): Promise<void> {
  // Defense-in-depth: both RealDiscordClient and InMemoryDiscordClient drop
  // bot-authored messages before invoking subscribers. This second guard
  // protects against a future client implementation that forgets to gate.
  if (msg.authorBot) return;
  if (!sessionManager.has(msg.threadId)) {
    log.info(`[handler] no active session for thread ${msg.threadId}, skipping`);
    return;
  }

  await client.sendTyping(msg.threadId);

  try {
    const result = await sessionManager.sendMessage(
      msg.threadId,
      msg.content,
      msg.attachments,
    );
    log.info(
      `[handler] relay returned ${result.chunks.length} chunks, error=${result.error ?? "none"}`,
    );
    for (const chunk of result.chunks) {
      if (chunk.trim()) {
        await client.sendToThread(msg.threadId, chunk);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`[handler] relay error in thread ${msg.threadId}:`, errMsg);
    try {
      await client.sendToThread(
        msg.threadId,
        `⚠️ Claude Code への中継中にエラーが発生しました: ${errMsg.slice(0, 1900)}`,
      );
    } catch (sendErr) {
      log.error(`[handler] error notification failed:`, sendErr);
    }
  }
}
