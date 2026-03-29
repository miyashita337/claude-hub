import { spawn, execSync } from "child_process";
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
  getLastSessionByChannel,
} from "../infra/db";
import { openTab, markTabStopped } from "./iterm2";

const LOGS_DIR = resolve(homedir(), "claude-hub", "logs", "sessions");

const CLAUDE_PATH = resolve(homedir(), ".local", "bin", "claude");
const TMUX_PATH = "/opt/homebrew/bin/tmux";
const TMUX_SESSION_PREFIX = "claude-";

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();

  constructor() {
    mkdirSync(LOGS_DIR, { recursive: true });
    this.recoverFromDb();
  }

  count(): number {
    return this.sessions.size;
  }

  has(channelName: string): boolean {
    return this.sessions.has(channelName);
  }

  get(channelName: string): SessionInfo | undefined {
    return this.sessions.get(channelName);
  }

  entries(): IterableIterator<[string, SessionInfo]> {
    return this.sessions.entries();
  }

  listRunning(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  private tmuxSessionName(channelName: string): string {
    return `${TMUX_SESSION_PREFIX}${channelName}`;
  }

  private getTmuxPid(sessionName: string): number | null {
    try {
      const output = execSync(
        `${TMUX_PATH} list-panes -t "${sessionName}" -F "#{pane_pid}" 2>/dev/null`,
        { encoding: "utf8" }
      ).trim();
      const pid = parseInt(output.split("\n")[0], 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  private isTmuxSessionAlive(sessionName: string): boolean {
    try {
      execSync(`${TMUX_PATH} has-session -t "${sessionName}" 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  start(config: ChannelConfig): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`最大セッション数 (${MAX_SESSIONS}) に達しています`);
    }

    if (this.sessions.has(config.channelName)) {
      throw new Error(
        `${config.displayName} のセッションは既に稼働中です`
      );
    }

    if (!existsSync(config.dir)) {
      throw new Error(
        `プロジェクトディレクトリが見つかりません: ${config.dir}`
      );
    }

    const sessionId = randomUUID();
    const tmuxName = this.tmuxSessionName(config.channelName);

    // Kill existing tmux session if any
    try {
      execSync(`${TMUX_PATH} kill-session -t "${tmuxName}" 2>/dev/null`);
    } catch {
      // No existing session
    }

    // Resolve bot token from .env
    const botToken = process.env[config.botTokenEnvKey];
    if (!botToken) {
      throw new Error(
        `Bot トークンが未設定です: ${config.botTokenEnvKey}\n.env に設定してください`
      );
    }

    // Per-session state directory for Discord plugin isolation
    const stateDir = resolve(homedir(), ".claude", "channels", `discord-${config.channelName}`);
    mkdirSync(stateDir, { recursive: true });

    // Build the claude command — no pipes to preserve TTY stdin
    const claudeCmd = [
      `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
      `export DISCORD_BOT_TOKEN="${botToken}"`,
      `export DISCORD_STATE_DIR="${stateDir}"`,
      `cd "${config.dir}"`,
      `exec ${CLAUDE_PATH} --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions --name "${config.channelName}"`,
    ].join(" && ");

    // Launch via tmux (provides a real TTY)
    execSync(
      `${TMUX_PATH} new-session -d -s "${tmuxName}" '${claudeCmd}'`
    );

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
      projectDir: config.dir,
      pid,
      process: null as unknown as any, // tmux manages the process
      startedAt: now,
      lastActivityAt: now,
      status: "running",
    };

    this.sessions.set(config.channelName, info);

    insertSession({
      id: sessionId,
      channel_name: config.channelName,
      project_dir: config.dir,
      pid,
      claude_session_id: null,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      status: "running",
    });

    // Monitor tmux session for exit
    this.watchTmuxSession(config.channelName, tmuxName, sessionId);

    console.log(
      `[SessionManager] Started ${config.channelName} via tmux (PID: ${pid}, session: ${tmuxName})`
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

  async resume(config: ChannelConfig): Promise<SessionInfo> {
    if (this.sessions.has(config.channelName)) {
      throw new Error(
        `${config.displayName} のセッションは既に稼働中です`
      );
    }

    const lastSession = getLastSessionByChannel(config.channelName);
    if (!lastSession?.claude_session_id) {
      return this.start(config);
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`最大セッション数 (${MAX_SESSIONS}) に達しています`);
    }

    const sessionId = randomUUID();
    const tmuxName = this.tmuxSessionName(config.channelName);

    try {
      execSync(`${TMUX_PATH} kill-session -t "${tmuxName}" 2>/dev/null`);
    } catch {
      // No existing session
    }

    const botToken = process.env[config.botTokenEnvKey];
    if (!botToken) {
      throw new Error(
        `Bot トークンが未設定です: ${config.botTokenEnvKey}\n.env に設定してください`
      );
    }

    const stateDir = resolve(homedir(), ".claude", "channels", `discord-${config.channelName}`);
    mkdirSync(stateDir, { recursive: true });

    const claudeCmd = [
      `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
      `export DISCORD_BOT_TOKEN="${botToken}"`,
      `export DISCORD_STATE_DIR="${stateDir}"`,
      `cd "${config.dir}"`,
      `exec ${CLAUDE_PATH} --resume "${lastSession.claude_session_id}" --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions --name "${config.channelName}"`,
    ].join(" && ");

    execSync(
      `${TMUX_PATH} new-session -d -s "${tmuxName}" '${claudeCmd}'`
    );

    let pid: number | null = null;
    for (let i = 0; i < 5; i++) {
      pid = this.getTmuxPid(tmuxName);
      if (pid) break;
      execSync("sleep 0.5");
    }

    if (!pid) {
      throw new Error(
        "Claude Code の復帰に失敗しました（tmuxセッションのPID取得失敗）"
      );
    }

    const now = new Date();
    const info: SessionInfo = {
      id: sessionId,
      channelName: config.channelName,
      projectDir: config.dir,
      pid,
      process: null as unknown as any,
      claudeSessionId: lastSession.claude_session_id,
      startedAt: now,
      lastActivityAt: now,
      status: "running",
    };

    this.sessions.set(config.channelName, info);

    insertSession({
      id: sessionId,
      channel_name: config.channelName,
      project_dir: config.dir,
      pid,
      claude_session_id: lastSession.claude_session_id,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      status: "running",
    });

    this.watchTmuxSession(config.channelName, tmuxName, sessionId);

    console.log(
      `[SessionManager] Resumed ${config.channelName} via tmux (PID: ${pid}, session: ${tmuxName})`
    );

    setTimeout(() => {
      openTab({
        tmuxSessionName: tmuxName,
        channelName: config.channelName,
        projectDir: config.dir,
      });
    }, 0);

    return info;
  }

  async stop(
    channelName: string,
    reason: StopReason = "manual"
  ): Promise<void> {
    const session = this.sessions.get(channelName);
    if (!session) {
      throw new Error(`${channelName} のセッションが見つかりません`);
    }

    session.status = "stopping";
    const tmuxName = this.tmuxSessionName(channelName);

    console.log(
      `[SessionManager] Stopping ${channelName} (reason: ${reason})`
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
          execSync(`${TMUX_PATH} kill-session -t "${tmuxName}" 2>/dev/null`);
        } catch {
          // Already dead
        }
        resolve();
      }, GRACEFUL_KILL_TIMEOUT_MS);
    });

    this.sessions.delete(channelName);
    markTabStopped(channelName);
    updateSessionStatus(session.id, "stopped", reason);
  }

  touchActivity(channelName: string): void {
    const session = this.sessions.get(channelName);
    if (session) {
      session.lastActivityAt = new Date();
      updateSessionActivity(session.id);
    }
  }

  async shutdownAll(): Promise<void> {
    console.log("[SessionManager] Shutting down all sessions...");
    const promises = Array.from(this.sessions.keys()).map((name) =>
      this.stop(name, "manual").catch((err) =>
        console.error(`[SessionManager] Error stopping ${name}:`, err)
      )
    );
    await Promise.allSettled(promises);
    console.log("[SessionManager] All sessions stopped.");
  }

  private watchTmuxSession(
    channelName: string,
    tmuxName: string,
    sessionId: string
  ): void {
    const interval = setInterval(() => {
      if (!this.isTmuxSessionAlive(tmuxName)) {
        console.log(
          `[SessionManager] tmux session ${tmuxName} exited`
        );
        this.sessions.delete(channelName);
        markTabStopped(channelName);
        updateSessionStatus(sessionId, "stopped", "tmux_exited");
        clearInterval(interval);
      }
    }, 10_000); // Check every 10 seconds
  }

  private recoverFromDb(): void {
    const rows = getRunningSessions();
    for (const row of rows) {
      const tmuxName = this.tmuxSessionName(row.channel_name);
      if (this.isTmuxSessionAlive(tmuxName)) {
        console.log(
          `[SessionManager] Found running tmux session ${tmuxName}, marking as stopped (supervisor restart)`
        );
        try {
          execSync(`${TMUX_PATH} kill-session -t "${tmuxName}" 2>/dev/null`);
        } catch {
          // ignore
        }
      }
      updateSessionStatus(row.id, "stopped", "supervisor_restart");
    }
  }
}
