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

export async function startBot(token: string): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const sessionManager = new SessionManager();
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
  });

  // Handle slash commands
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "session") return;

    try {
      await sessionHandler(interaction);
    } catch (err) {
      console.error("[Bot] Command error:", err);
      const content = `❌ エラーが発生しました: ${err instanceof Error ? err.message : String(err)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, flags: 64 });
      }
    }
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

    // Show typing indicator
    try {
      await thread.sendTyping();
    } catch {
      // Ignore typing errors
    }

    // Relay to Claude Code
    console.log(`[Bot] Relaying message in thread ${threadId}: "${messageText.slice(0, 50)}"`);
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
    } catch (err) {
      console.error(`[Bot] Relay error in thread ${threadId}:`, err);
      await thread.send(
        `⚠️ Claude Code への中継中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
