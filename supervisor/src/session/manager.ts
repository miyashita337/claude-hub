import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { SessionInfo, StopReason } from "./types";
import type { ChannelConfig } from "../config/channels";
import {
  MAX_SESSIONS,
} from "../config/channels";
import {
  insertSession,
  updateSessionStatus,
  updateSessionActivity,
  getRunningSessions,
  getLastSessionByThread,
  getRunningSessionsByChannel,
} from "../infra/db";
import { relayMessage, type AttachmentInfo, type RelayResult } from "./relay";

export class SessionManager {
  /** Map<threadId, SessionInfo> — one session per thread */
  private sessions = new Map<string, SessionInfo>();

  constructor() {
    this.recoverFromDb();
  }

  count(): number {
    return this.sessions.size;
  }

  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  hasChannel(channelName: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.channelName === channelName && session.status === "running") {
        return true;
      }
    }
    return false;
  }

  get(threadId: string): SessionInfo | undefined {
    return this.sessions.get(threadId);
  }

  entries(): IterableIterator<[string, SessionInfo]> {
    return this.sessions.entries();
  }

  listRunning(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  listRunningByChannel(channelName: string): SessionInfo[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.channelName === channelName && s.status === "running"
    );
  }

  /**
   * Start a new session. Returns SessionInfo (threadId must be set by caller after thread creation).
   */
  start(config: ChannelConfig, threadId: string): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`最大セッション数 (${MAX_SESSIONS}) に達しています`);
    }

    if (this.sessions.has(threadId)) {
      throw new Error(`このスレッドのセッションは既に稼働中です`);
    }

    if (!existsSync(config.dir)) {
      throw new Error(
        `プロジェクトディレクトリが見つかりません: ${config.dir}`
      );
    }

    const sessionId = randomUUID();
    const now = new Date();

    const info: SessionInfo = {
      id: sessionId,
      channelName: config.channelName,
      threadId,
      projectDir: config.dir,
      pid: 0, // No persistent process in -p mode
      process: null as unknown as any,
      startedAt: now,
      lastActivityAt: now,
      status: "running",
    };

    this.sessions.set(threadId, info);

    insertSession({
      id: sessionId,
      channel_name: config.channelName,
      thread_id: threadId,
      project_dir: config.dir,
      pid: null,
      claude_session_id: null,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      status: "running",
    });

    console.log(
      `[SessionManager] Started session ${sessionId} for ${config.channelName} in thread ${threadId}`
    );

    return info;
  }

  /**
   * Send a message to the Claude Code session and get the response.
   */
  async sendMessage(
    threadId: string,
    message: string,
    attachments?: AttachmentInfo[]
  ): Promise<RelayResult> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`スレッド ${threadId} にセッションが見つかりません`);
    }

    // Update activity timestamp
    session.lastActivityAt = new Date();
    updateSessionActivity(session.id);

    const result = await relayMessage({
      sessionId: session.id,
      projectDir: session.projectDir,
      claudeSessionId: session.claudeSessionId,
      message,
      attachments,
    });

    // Save claude session ID for future --resume
    if (result.claudeSessionId && !session.claudeSessionId) {
      session.claudeSessionId = result.claudeSessionId;
    }

    return result;
  }

  async stop(
    threadId: string,
    reason: StopReason = "manual"
  ): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`スレッド ${threadId} にセッションが見つかりません`);
    }

    session.status = "stopping";

    console.log(
      `[SessionManager] Stopping session in thread ${threadId} (reason: ${reason})`
    );

    this.sessions.delete(threadId);
    updateSessionStatus(session.id, "stopped", reason);
  }

  touchActivity(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.lastActivityAt = new Date();
      updateSessionActivity(session.id);
    }
  }

  async shutdownAll(): Promise<void> {
    console.log("[SessionManager] Shutting down all sessions...");
    const promises = Array.from(this.sessions.keys()).map((threadId) =>
      this.stop(threadId, "manual").catch((err) =>
        console.error(`[SessionManager] Error stopping ${threadId}:`, err)
      )
    );
    await Promise.allSettled(promises);
    console.log("[SessionManager] All sessions stopped.");
  }

  private recoverFromDb(): void {
    const rows = getRunningSessions();
    for (const row of rows) {
      // Mark all previously running sessions as stopped on restart
      // (no persistent process to clean up in -p mode)
      updateSessionStatus(row.id, "stopped", "supervisor_restart");
    }
  }
}
