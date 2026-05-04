// Discord client abstraction (Issue #144 Phase 1).
//
// The interface captures the minimum surface needed by bot.ts and the
// upcoming lifecycle E2E test. RealDiscordClient wraps discord.js Client;
// InMemoryDiscordClient is a queue-based fake that lets tests inject
// thread messages and slash commands without a real Gateway connection.

import type { AttachmentInfo } from "../session/relay";

export type { AttachmentInfo };

export interface DiscordThreadMessage {
  threadId: string;
  messageId: string;
  authorId: string;
  authorBot: boolean;
  content: string;
  attachments: AttachmentInfo[];
}

export interface DiscordFileAttachment {
  name: string;
  /** Absolute path or in-memory buffer. */
  attachment: string | Buffer;
}

export interface DiscordSendOptions {
  files?: DiscordFileAttachment[];
}

export interface DiscordSlashCommand {
  commandName: string;
  options: Record<string, string | number | boolean>;
  channelId: string;
  userId: string;
  /** Reply to the slash command. ephemeral=true mirrors discord.js flags=64. */
  reply(content: string, ephemeral?: boolean): Promise<void>;
}

export type ThreadMessageHandler = (msg: DiscordThreadMessage) => void;
export type SlashCommandHandler = (cmd: DiscordSlashCommand) => void;

export interface IDiscordClient {
  /** Connect (Real: client.login). Idempotent: subsequent calls resolve immediately. */
  start(): Promise<void>;

  /** Disconnect (Real: client.destroy). After stop(), send* must throw. */
  stop(): Promise<void>;

  /** Send a message to a Discord thread. Throws if not running or thread unknown. */
  sendToThread(
    threadId: string,
    content: string,
    options?: DiscordSendOptions,
  ): Promise<void>;

  /** Send typing indicator. Best-effort: never throws on transient API errors. */
  sendTyping(threadId: string): Promise<void>;

  /** Subscribe to thread message events. Multiple handlers fire in registration order. */
  onThreadMessage(handler: ThreadMessageHandler): void;

  /** Subscribe to slash command events. */
  onSlashCommand(handler: SlashCommandHandler): void;
}
