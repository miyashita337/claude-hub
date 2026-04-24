import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { SessionInfo, StopReason } from "./types";
import type { ChannelConfig } from "../config/channels";
import {
  MAX_SESSIONS,
  GRACEFUL_KILL_TIMEOUT_MS,
} from "../config/channels";
import {
  insertSession,
  updateSessionStatus,
  updateSessionActivity,
  getRunningSessions,
} from "../infra/db";
import { openTab, markTabStopped } from "./iterm2";
import { relayMessage, type AttachmentInfo, type RelayResult } from "./relay";
import {
  startRelayServer,
  stopRelayServer,
  getRelayPort,
  cancelRelay,
} from "./relay-server";
import { TMUX_CMD, ensureSocketConfigured } from "./tmux";

const CLAUDE_PATH = resolve(homedir(), ".local", "bin", "claude");
const TMUX_SESSION_PREFIX = "claude-";

export class SessionManager {
  /** Map<threadId, SessionInfo> — one session per thread */
  private sessions = new Map<string, SessionInfo>();

  constructor() {
    ensureSocketConfigured();
    startRelayServer();
    this.recoverFromDb();
  }

  count(): number {
    return this.sessions.size;
  }

  has(threadId: string): boolean {
    return this.sessions.has(threadId);
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

  private tmuxSessionName(threadId: string): string {
    // Use a short prefix + first 8 chars of threadId for tmux session name
    return `${TMUX_SESSION_PREFIX}${threadId.slice(0, 12)}`;
  }

  private getTmuxPid(sessionName: string): number | null {
    try {
      const output = execSync(
        `${TMUX_CMD} list-panes -t "${sessionName}" -F "#{pane_pid}" 2>/dev/null`,
        { encoding: "utf8" }
      ).trim();
      const pid = parseInt(output.split("\n")[0] ?? "", 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  private isTmuxSessionAlive(sessionName: string): boolean {
    try {
      execSync(`${TMUX_CMD} has-session -t "${sessionName}" 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start a new session with tmux + iTerm2 + thread.
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
    const tmuxName = this.tmuxSessionName(threadId);

    // Kill existing tmux session if any
    try {
      execSync(`${TMUX_CMD} kill-session -t "${tmuxName}" 2>/dev/null`);
    } catch {
      // No existing session
    }

    // Build the claude command — unset ANTHROPIC_API_KEY to use Claude Max subscription
    const relayUrl = `http://localhost:${getRelayPort()}/relay/${threadId}`;

    const claudeCmd = [
      "unset ANTHROPIC_API_KEY",
      `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
      `export SUPERVISOR_RELAY_URL="${relayUrl}"`,
      `printf "%s" "${relayUrl}" > "${config.dir}/.supervisor-relay-url"`,
      `cd "${config.dir}"`,
      `exec ${CLAUDE_PATH} --dangerously-skip-permissions --name "${config.channelName}"`,
    ].join(" && ");

    // Launch via tmux (provides a real TTY). Uses Supervisor's dedicated
    // -L claude-hub socket (see ./tmux.ts) so user config is not inherited.
    execSync(
      `${TMUX_CMD} new-session -d -s "${tmuxName}" '${claudeCmd}'`
    );
    // Apply server-wide options now that the server is definitely running.
    // The constructor's eager call is a no-op before the first new-session.
    ensureSocketConfigured();

    // Wait briefly for process to start
    let pid: number | null = null;
    for (let i = 0; i < 5; i++) {
      pid = this.getTmuxPid(tmuxName);
      if (pid) break;
      execSync("sleep 0.5");
    }

    if (!pid) {
      throw new Error(
        "Claude Code の起動に失敗しました（tmuxセッションのPID取得失敗）"
      );
    }

    const now = new Date();
    const info: SessionInfo = {
      id: sessionId,
      channelName: config.channelName,
      threadId,
      projectDir: config.dir,
      pid,
      process: null as unknown as any, // tmux manages the process
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
      pid,
      claude_session_id: null,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      status: "running",
    });

    // Monitor tmux session for exit
    this.watchTmuxSession(threadId, tmuxName, sessionId);

    console.log(
      `[SessionManager] Started ${config.channelName} via tmux (PID: ${pid}, tmux: ${tmuxName}, thread: ${threadId})`
    );

    // Open iTerm2 tab asynchronously (non-blocking, failure is safe)
    setTimeout(() => {
      openTab({
        tmuxSessionName: tmuxName,
        channelName: config.channelName,
        projectDir: config.dir,
      });
    }, 0);

    return info;
  }

  /**
   * Send a message to the Claude Code session via tmux and get the response.
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

    const tmuxName = this.tmuxSessionName(threadId);

    // Check tmux session is alive
    if (!this.isTmuxSessionAlive(tmuxName)) {
      return {
        text: "",
        chunks: ["⚠️ Claude Code セッションが終了しています。`/session start` で再起動してください。"],
        error: "tmux session dead",
      };
    }

    return relayMessage(tmuxName, threadId, message, { attachments });
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
    cancelRelay(threadId);
    const tmuxName = this.tmuxSessionName(threadId);

    console.log(
      `[SessionManager] Stopping ${session.channelName} in thread ${threadId} (reason: ${reason})`
    );

    // Send SIGTERM to the claude process
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {
      // Process already dead
    }

    // Wait for graceful shutdown, then force kill tmux session
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          execSync(`${TMUX_CMD} kill-session -t "${tmuxName}" 2>/dev/null`);
        } catch {
          // Already dead
        }
        resolve();
      }, GRACEFUL_KILL_TIMEOUT_MS);
    });

    this.sessions.delete(threadId);
    markTabStopped(session.channelName);
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
    stopRelayServer();
    console.log("[SessionManager] All sessions stopped.");
  }

  private watchTmuxSession(
    threadId: string,
    tmuxName: string,
    sessionId: string
  ): void {
    const interval = setInterval(() => {
      if (!this.isTmuxSessionAlive(tmuxName)) {
        const session = this.sessions.get(threadId);
        console.log(
          `[SessionManager] tmux session ${tmuxName} exited`
        );
        this.sessions.delete(threadId);
        if (session) {
          markTabStopped(session.channelName);
        }
        updateSessionStatus(sessionId, "stopped", "tmux_exited");
        clearInterval(interval);
      }
    }, 10_000); // Check every 10 seconds
  }

  private recoverFromDb(): void {
    const rows = getRunningSessions();
    for (const row of rows) {
      if (row.thread_id) {
        const tmuxName = this.tmuxSessionName(row.thread_id);
        if (this.isTmuxSessionAlive(tmuxName)) {
          console.log(
            `[SessionManager] Found running tmux session ${tmuxName}, killing (supervisor restart)`
          );
          try {
            execSync(`${TMUX_CMD} kill-session -t "${tmuxName}" 2>/dev/null`);
          } catch {
            // ignore
          }
        }
      }
      updateSessionStatus(row.id, "stopped", "supervisor_restart");
    }
  }
}
