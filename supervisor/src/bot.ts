import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  type Interaction,
} from "discord.js";
import { SessionManager } from "./session/manager";
import { Reaper } from "./session/reaper";
import { ResourceMonitor } from "./session/resource-monitor";
import { createSessionCommand, createSessionHandler } from "./commands/session";
import { CHANNEL_MAP } from "./config/channels";

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
      // Register commands globally (takes up to 1 hour to propagate)
      // For immediate testing, use guild-specific registration
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
      const reply = {
        content: `❌ エラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
        flags: 64 as const,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  });

  // Track activity: update lastActivityAt when messages are sent in registered channels
  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    const channelName =
      "name" in message.channel ? message.channel.name : "";
    if (CHANNEL_MAP.has(channelName)) {
      sessionManager.touchActivity(channelName);
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
