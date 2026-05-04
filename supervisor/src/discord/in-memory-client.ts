// InMemoryDiscordClient — in-process fake of IDiscordClient for tests.
//
// Phase 1 (Issue #144): supports event injection (injectThreadMessage,
// injectSlashCommand) and exposes sent message / typing logs so the
// upcoming lifecycle E2E test can assert the supervisor's outbound side.

import type {
  DiscordSendOptions,
  DiscordSlashCommand,
  DiscordThreadMessage,
  IDiscordClient,
  SlashCommandHandler,
  ThreadMessageHandler,
} from "./types";

export interface SentMessageRecord {
  threadId: string;
  content: string;
  options: DiscordSendOptions;
  ts: number;
}

export interface InjectThreadMessageInput {
  threadId: string;
  content: string;
  messageId?: string;
  authorId?: string;
  authorBot?: boolean;
  attachments?: DiscordThreadMessage["attachments"];
}

export interface InjectSlashCommandInput {
  commandName: string;
  options?: Record<string, string | number | boolean>;
  channelId?: string;
  userId?: string;
  /** Optional capture for reply() invocations. Defaults to a recording function. */
  onReply?: (content: string, ephemeral: boolean) => void | Promise<void>;
}

export class InMemoryDiscordClient implements IDiscordClient {
  private readonly threadHandlers: ThreadMessageHandler[] = [];
  private readonly slashHandlers: SlashCommandHandler[] = [];
  private readonly sentMessages: SentMessageRecord[] = [];
  private readonly typingCalls = new Map<string, number>();
  private readonly slashReplies: Array<{
    commandName: string;
    content: string;
    ephemeral: boolean;
  }> = [];
  private readonly handlerErrors: unknown[] = [];
  private started = false;
  private stopped = false;
  private autoIncrementId = 1;

  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("InMemoryDiscordClient: cannot start after stop()");
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
  }

  async sendToThread(
    threadId: string,
    content: string,
    options: DiscordSendOptions = {},
  ): Promise<void> {
    this.assertRunning();
    this.sentMessages.push({
      threadId,
      content,
      options: { ...options },
      ts: Date.now(),
    });
  }

  async sendTyping(threadId: string): Promise<void> {
    this.assertRunning();
    this.typingCalls.set(threadId, (this.typingCalls.get(threadId) ?? 0) + 1);
  }

  onThreadMessage(handler: ThreadMessageHandler): void {
    this.threadHandlers.push(handler);
  }

  onSlashCommand(handler: SlashCommandHandler): void {
    this.slashHandlers.push(handler);
  }

  // ---- Test injection API (not part of IDiscordClient) ----

  /** Fire a thread message event. Bot-authored messages are gated like RealDiscordClient. */
  injectThreadMessage(input: InjectThreadMessageInput): void {
    this.assertRunning();
    const event: DiscordThreadMessage = {
      threadId: input.threadId,
      messageId: input.messageId ?? `msg_${this.autoIncrementId++}`,
      authorId: input.authorId ?? "user_test",
      authorBot: input.authorBot ?? false,
      content: input.content,
      attachments: input.attachments ?? [],
    };
    if (event.authorBot) return; // Mirror RealDiscordClient gating.
    // Mirror RealDiscordClient's per-handler isolation: one throwing handler
    // shouldn't stop the chain. Errors are recorded so tests can assert on
    // them via getHandlerErrors().
    for (const h of this.threadHandlers) {
      try {
        h(event);
      } catch (err) {
        this.handlerErrors.push(err);
      }
    }
  }

  /** Fire a slash command event. reply() recordings are exposed via getSlashReplies(). */
  injectSlashCommand(input: InjectSlashCommandInput): void {
    this.assertRunning();
    const recordReply = async (content: string, ephemeral?: boolean) => {
      const eph = ephemeral ?? false;
      this.slashReplies.push({
        commandName: input.commandName,
        content,
        ephemeral: eph,
      });
      if (input.onReply) await input.onReply(content, eph);
    };
    const cmd: DiscordSlashCommand = {
      commandName: input.commandName,
      options: input.options ?? {},
      channelId: input.channelId ?? "channel_test",
      userId: input.userId ?? "user_test",
      reply: recordReply,
    };
    for (const h of this.slashHandlers) {
      try {
        h(cmd);
      } catch (err) {
        this.handlerErrors.push(err);
      }
    }
  }

  // ---- Inspection API ----

  getSentMessages(threadId?: string): SentMessageRecord[] {
    return threadId
      ? this.sentMessages.filter((m) => m.threadId === threadId)
      : [...this.sentMessages];
  }

  getTypingCallCount(threadId: string): number {
    return this.typingCalls.get(threadId) ?? 0;
  }

  getSlashReplies(): ReadonlyArray<{
    commandName: string;
    content: string;
    ephemeral: boolean;
  }> {
    return this.slashReplies;
  }

  isStarted(): boolean {
    return this.started && !this.stopped;
  }

  /** Errors thrown by handlers during inject*. The chain itself is never broken. */
  getHandlerErrors(): readonly unknown[] {
    return this.handlerErrors;
  }

  /** Reset all recorded interactions but keep registered handlers. */
  clearLogs(): void {
    this.sentMessages.length = 0;
    this.typingCalls.clear();
    this.slashReplies.length = 0;
    this.handlerErrors.length = 0;
  }

  private assertRunning(): void {
    if (!this.started) throw new Error("InMemoryDiscordClient: not started");
    if (this.stopped) throw new Error("InMemoryDiscordClient: already stopped");
  }
}
