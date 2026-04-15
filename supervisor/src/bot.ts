import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  type Interaction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { SessionManager } from "./session/manager";
import { Reaper } from "./session/reaper";
import { ResourceMonitor } from "./session/resource-monitor";
import { createSessionCommand, createSessionHandler } from "./commands/session";
import { CHANNEL_MAP } from "./config/channels";
import type { AttachmentInfo } from "./session/relay";
import { updateSessionClaudeId } from "./infra/db";
import { onProgress, onLateResponse } from "./session/relay-server";
import {
  extractFilePaths,
  collectAttachableFiles,
} from "./session/file-attacher";

export async function startBot(token: string): Promise<void> {
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
    const next = prev.then(task, task);
    threadQueues.set(threadId, next);
    next.finally(() => {
      if (threadQueues.get(threadId) === next) {
        threadQueues.delete(threadId);
      }
    });
  }
  const reaper = new Reaper(sessionManager, client);
  const resourceMonitor = new ResourceMonitor(sessionManager);
  const sessionHandler = createSessionHandler(sessionManager);

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
    resourceMonitor.start();

    // Register progress callback to send tool progress to Discord threads
    onProgress(async (event) => {
      try {
        const channel = await client.channels.fetch(event.threadId);
        if (channel?.isThread()) {
          await channel.send(`🔧 \`${event.tool}\`: ${event.message}`);
        }
      } catch (err) {
        console.error(`[Bot] Progress send error for thread ${event.threadId}:`, err);
      }
    });

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

  // Message relay: thread messages → Claude Code → thread reply
  client.on(Events.MessageCreate, async (message: Message) => {
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

    // Check if this thread has an active session
    if (!sessionManager.has(threadId)) {
      return; // Not a session thread, ignore
    }

    const thread = message.channel as ThreadChannel;

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

    // Enqueue to prevent concurrent relay for the same thread.
    // Without this, the second message overwrites the first's pending request
    // in relay-server and the first response is lost.
    enqueueForThread(threadId, async () => {
      // Show typing indicator
      try {
        await thread.sendTyping();
      } catch {
        // Ignore typing errors
      }

      // Relay to Claude Code
      console.log(
        `[Bot] Relaying message in thread ${threadId} (${messageText.length} chars, ${attachments.length} attachments)`
      );
      try {
        const result = await sessionManager.sendMessage(
          threadId,
          messageText,
          attachments
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
      } catch (err) {
        console.error(`[Bot] Relay error in thread ${threadId}:`, err);
        await thread.send(
          `⚠️ Claude Code への中継中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Bot] Shutdown signal received");
    reaper.stop();
    resourceMonitor.stop();
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
