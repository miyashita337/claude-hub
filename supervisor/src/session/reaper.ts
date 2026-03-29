import type { SessionManager } from "./manager";
import type { TextChannel } from "discord.js";
import type { Client } from "discord.js";
import {
  IDLE_TIMEOUT_MS,
  IDLE_CHECK_INTERVAL_MS,
} from "../config/channels";

export class Reaper {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionManager: SessionManager,
    private client: Client
  ) {}

  start(): void {
    this.timer = setInterval(() => this.check(), IDLE_CHECK_INTERVAL_MS);
    console.log(
      `[Reaper] Started (check every ${IDLE_CHECK_INTERVAL_MS / 1000 / 60}min, timeout ${IDLE_TIMEOUT_MS / 1000 / 60 / 60 / 24}days)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    const now = Date.now();
    for (const [name, session] of this.sessionManager.entries()) {
      const idleMs = now - session.lastActivityAt.getTime();
      if (idleMs > IDLE_TIMEOUT_MS) {
        console.log(
          `[Reaper] ${name} idle for ${(idleMs / 1000 / 60 / 60 / 24).toFixed(1)} days, terminating`
        );
        await this.sessionManager.stop(name, "idle_timeout");
        await this.notifyChannel(name);
      }
    }
  }

  private async notifyChannel(channelName: string): Promise<void> {
    try {
      const channel = this.client.channels.cache.find(
        (ch) => ch.isTextBased() && "name" in ch && ch.name === channelName
      ) as TextChannel | undefined;

      if (channel) {
        await channel.send(
          `⏰ 7日間無操作のためセッションを自動終了しました。\n再開するには \`/session resume\` を使用してください。`
        );
      }
    } catch (err) {
      console.error(`[Reaper] Failed to notify channel ${channelName}:`, err);
    }
  }
}
