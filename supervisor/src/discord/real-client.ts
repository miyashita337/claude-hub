// RealDiscordClient — thin wrapper over discord.js Client implementing IDiscordClient.
//
// Phase 1 (Issue #144): not yet wired into bot.ts. The wrapper exists so Phase 2's
// lifecycle E2E test can swap in InMemoryDiscordClient at the same seam.
// Phase 2 will migrate bot.ts to construct the client through this interface.

import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import type {
  AttachmentInfo,
  DiscordSendOptions,
  DiscordSlashCommand,
  DiscordThreadMessage,
  IDiscordClient,
  SlashCommandHandler,
  ThreadMessageHandler,
} from "./types";

export interface RealDiscordClientOptions {
  /** discord.js intents. Defaults match bot.ts for backwards compatibility. */
  intents?: GatewayIntentBits[];
  /** Inject a Client for tests; production callers leave this undefined. */
  client?: Client;
}

const DEFAULT_INTENTS: GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

export class RealDiscordClient implements IDiscordClient {
  private readonly client: Client;
  private readonly token: string;
  private readonly threadHandlers: ThreadMessageHandler[] = [];
  private readonly slashHandlers: SlashCommandHandler[] = [];
  private started = false;
  private stopped = false;

  constructor(token: string, options: RealDiscordClientOptions = {}) {
    if (!token) throw new Error("RealDiscordClient: token is required");
    this.token = token;
    this.client =
      options.client ??
      new Client({ intents: options.intents ?? DEFAULT_INTENTS });

    this.client.on(Events.MessageCreate, (message: Message) => {
      // Mirror bot.ts gating: only thread messages from non-bot users propagate.
      if (message.author.bot) return;
      if (!message.channel.isThread()) return;
      const thread = message.channel as ThreadChannel;
      const attachments: AttachmentInfo[] = [];
      for (const [, att] of message.attachments) {
        attachments.push({
          url: att.url,
          filename: att.name ?? "attachment",
          contentType: att.contentType ?? "application/octet-stream",
        });
      }
      const event: DiscordThreadMessage = {
        threadId: thread.id,
        messageId: message.id,
        authorId: message.author.id,
        authorBot: message.author.bot,
        content: message.content,
        attachments,
      };
      for (const h of this.threadHandlers) {
        try {
          h(event);
        } catch (err) {
          console.error("[RealDiscordClient] thread handler threw:", err);
        }
      }
    });

    this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return;
      // discord.js options.data carries primitives for STRING / INTEGER /
      // BOOLEAN / NUMBER and complex objects (User, Channel, Role, Attachment)
      // for resolved types. The interface only exposes primitives — gate on
      // typeof so a complex option doesn't sneak through as `[object Object]`.
      // Subcommand support: when /session start is invoked, data[0] has
      // type=SUB_COMMAND (1) and the actual options nest inside .options.
      // SUB_COMMAND_GROUP (2) nests one level deeper but no current command
      // uses it, so we flatten only one level.
      const opts: Record<string, string | number | boolean> = {};
      let subcommand: string | undefined;
      // ApplicationCommandOptionType: 1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP.
      const top = interaction.options.data;
      const subEntry =
        top.length === 1 && (top[0]!.type === 1 || top[0]!.type === 2)
          ? top[0]!
          : undefined;
      const optionList = subEntry?.options ?? top;
      if (subEntry) subcommand = subEntry.name;
      for (const opt of optionList) {
        const v = opt.value;
        if (
          v !== undefined &&
          v !== null &&
          (typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean")
        ) {
          opts[opt.name] = v;
        }
      }
      const cmd: DiscordSlashCommand = {
        commandName: interaction.commandName,
        ...(subcommand !== undefined ? { subcommand } : {}),
        options: opts,
        channelId: interaction.channelId ?? "",
        userId: interaction.user.id,
        reply: async (content: string, ephemeral?: boolean) => {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content });
          } else {
            await interaction.reply(
              ephemeral ? { content, flags: 64 } : { content },
            );
          }
        },
      };
      for (const h of this.slashHandlers) {
        try {
          h(cmd);
        } catch (err) {
          console.error("[RealDiscordClient] slash handler threw:", err);
        }
      }
    });
  }

  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("RealDiscordClient: cannot start after stop()");
    }
    if (this.started) return;
    // Mark as started AFTER successful login so a transient auth failure
    // leaves the client in the un-started state and the caller can retry
    // (CodeRabbit PR #145 review).
    await this.client.login(this.token);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.client.destroy();
  }

  async sendToThread(
    threadId: string,
    content: string,
    options: DiscordSendOptions = {},
  ): Promise<void> {
    this.assertRunning();
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isThread()) {
      throw new Error(
        `RealDiscordClient: channel is not a thread or not found: ${threadId}`,
      );
    }
    if (options.files?.length) {
      await channel.send({
        content,
        files: options.files.map((f) => ({
          attachment: f.attachment,
          name: f.name,
        })),
      });
    } else {
      await channel.send(content);
    }
  }

  async sendTyping(threadId: string): Promise<void> {
    this.assertRunning();
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (channel?.isThread()) await channel.sendTyping();
    } catch (err) {
      console.warn(
        `[RealDiscordClient] sendTyping failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  onThreadMessage(handler: ThreadMessageHandler): void {
    this.threadHandlers.push(handler);
  }

  onSlashCommand(handler: SlashCommandHandler): void {
    this.slashHandlers.push(handler);
  }

  /** Test-only escape hatch for callers that still need the underlying Client. */
  getUnderlyingClient(): Client {
    return this.client;
  }

  private assertRunning(): void {
    if (!this.started) throw new Error("RealDiscordClient: not started");
    if (this.stopped) throw new Error("RealDiscordClient: already stopped");
  }
}
