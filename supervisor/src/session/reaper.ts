import type { SessionManager } from "./manager";
import type { ThreadChannel, Client } from "discord.js";
import {
  IDLE_TIMEOUT_MS,
  IDLE_CHECK_INTERVAL_MS,
} from "../config/channels";
import { markTitleStopped } from "./thread-title";

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
        // Derive the day count from IDLE_TIMEOUT_MS so the message never drifts
        // out of sync with the constant (it used to hardcode "7日").
        const idleDays = Math.round(IDLE_TIMEOUT_MS / 1000 / 60 / 60 / 24);
        await thread.send(
          `⏰ ${idleDays}日間無操作のためセッションを自動終了しました。`
        );

        // Rename and archive. markTitleStopped also handles ♻️ resume threads,
        // which the old `.replace("🟢", ...)` skipped (Issue #175).
        const stoppedName = markTitleStopped(thread.name);
        await thread.setName(stoppedName);
        await thread.setArchived(true);
      }
    } catch (err) {
      console.error(`[Reaper] Failed to notify thread ${threadId}:`, err);
    }
  }
}
