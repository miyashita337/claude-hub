import type { SessionManager } from "./manager";
import type { ThreadChannel, Client } from "discord.js";
import {
  IDLE_CHECK_INTERVAL_MS,
  SESSION_IDLE_DEFAULT_MS,
  SESSION_IDLE_BACKSTOP_MS,
} from "../config/channels";
import { markTitleStopped } from "./thread-title";

/**
 * Resolve the effective idle-reap threshold (Phase 5b / #293). The primary
 * threshold comes from `SESSION_IDLE_TIMEOUT_MS` (default {@link
 * SESSION_IDLE_DEFAULT_MS} = 6h), but it is CAPPED at {@link
 * SESSION_IDLE_BACKSTOP_MS} (30 days) — the old 30-day value demoted to a hard
 * backstop so a misconfigured huge env value can never disable reaping. Setting
 * the env to 2592000000 (30d) restores the exact pre-#293 behaviour (AC-1).
 */
export function resolveIdleTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SESSION_IDLE_TIMEOUT_MS;
  const parsed = raw != null ? Number(raw) : NaN;
  const configured =
    Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : SESSION_IDLE_DEFAULT_MS;
  return Math.min(configured, SESSION_IDLE_BACKSTOP_MS);
}

export interface ReaperDeps {
  /** Effective idle timeout. Defaults to {@link resolveIdleTimeoutMs}. */
  idleTimeoutMs?: number;
  /** Poll interval. Defaults to {@link IDLE_CHECK_INTERVAL_MS}. */
  checkIntervalMs?: number;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Minimal snapshot captured before stop() removes the session, for the resume導線. */
interface ReapedSessionInfo {
  claudeSessionId?: string;
  branch?: string;
}

export class Reaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private sessionManager: SessionManager,
    private client: Client,
    deps: ReaperDeps = {},
  ) {
    this.idleTimeoutMs = deps.idleTimeoutMs ?? resolveIdleTimeoutMs();
    this.checkIntervalMs = deps.checkIntervalMs ?? IDLE_CHECK_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.check();
    }, this.checkIntervalMs);
    console.log(
      `[Reaper] Started (check every ${this.checkIntervalMs / 1000 / 60}min, idle timeout ${(this.idleTimeoutMs / 1000 / 60 / 60).toFixed(1)}h, backstop ${(SESSION_IDLE_BACKSTOP_MS / 1000 / 60 / 60 / 24).toFixed(0)}d)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scan tick. Public so tests can drive it deterministically. Snapshots the
   * session's resume identifiers BEFORE stop() removes it from the live map, so
   * the teardown notice can offer a `/session resume` path (#293).
   */
  async check(): Promise<void> {
    const now = this.now();
    for (const [threadId, session] of this.sessionManager.entries()) {
      const idleMs = now - session.lastActivityAt.getTime();
      if (idleMs > this.idleTimeoutMs) {
        const snapshot: ReapedSessionInfo = {
          claudeSessionId: session.claudeSessionId,
          branch: session.branch,
        };
        console.log(
          `[Reaper] Thread ${threadId} (${session.channelName}) idle for ${(idleMs / 1000 / 60 / 60).toFixed(1)}h (> ${(this.idleTimeoutMs / 1000 / 60 / 60).toFixed(1)}h), terminating`,
        );
        await this.sessionManager.stop(threadId, "idle_timeout");
        await this.notifyThread(threadId, idleMs, snapshot);
      }
    }
  }

  /**
   * Build the idle-teardown notice, including a resume導線 (#293). When the
   * session had a captured claude session id, offer `/session resume <id>` so the
   * user can pick the conversation back up; otherwise fall back to guiding a fresh
   * `/session start`. Static + deterministic so a unit test can assert the resume
   * line is present.
   */
  static buildIdleNotice(idleMs: number, info: ReapedSessionInfo): string {
    const idleHours = (idleMs / 1000 / 60 / 60).toFixed(1);
    const head = `⏰ ${idleHours} 時間無操作のためセッションを自動終了しました（省リソースのための idle reaper, #292）。`;
    if (info.claudeSessionId) {
      return (
        `${head}\n` +
        `↩️ 会話を続けるには \`/session resume ${info.claudeSessionId}\` を実行してください。`
      );
    }
    const startHint = info.branch
      ? `\`/session start ${info.branch}\``
      : "`/session start <branch>`";
    return `${head}\n↩️ 新しく始めるには ${startHint} を実行してください。`;
  }

  private async notifyThread(
    threadId: string,
    idleMs: number,
    info: ReapedSessionInfo,
  ): Promise<void> {
    try {
      let thread = this.client.channels.cache.get(threadId) as
        | ThreadChannel
        | undefined;
      // The idle horizon is now hours, but on a long-running / restarted
      // supervisor the thread may still be cache-evicted — fetch as a fallback so
      // the notice / rename / archive are not silently skipped.
      if (!thread) {
        thread = (await this.client.channels
          .fetch(threadId)
          .catch(() => undefined)) as ThreadChannel | undefined;
      }

      if (thread?.isThread()) {
        await thread.send(Reaper.buildIdleNotice(idleMs, info));
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
