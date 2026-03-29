import type { SessionManager } from "./manager";
import type { ThreadChannel, Client } from "discord.js";
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
    for (const [threadId, session] of this.sessionManager.entries()) {
      const idleMs = now - session.lastActivityAt.getTime();
      if (idleMs > IDLE_TIMEOUT_MS) {
        console.log(
          `[Reaper] Thread ${threadId} (${session.channelName}) idle for ${(idleMs / 1000 / 60 / 60 / 24).toFixed(1)} days, terminating`
        );
        await this.sessionManager.stop(threadId, "idle_timeout");
        await this.notifyThread(threadId);
      }
    }
  }

  private async notifyThread(threadId: string): Promise<void> {
    try {
      const thread = this.client.channels.cache.get(threadId) as
        | ThreadChannel
        | undefined;

      if (thread?.isThread()) {
        await thread.send(
          `⏰ 7日間無操作のためセッションを自動終了しました。`
        );

        // Rename and archive
        const stoppedName = thread.name.replace("🟢", "🔴");
        await thread.setName(stoppedName);
        await thread.setArchived(true);
      }
    } catch (err) {
      console.error(`[Reaper] Failed to notify thread ${threadId}:`, err);
    }
  }
}
