import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
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
import { relayMessage, type AttachmentInfo, type RelayResult } from "./relay";
import {
  realSessionEffects,
  type SessionEffects,
} from "./adapters";

const CLAUDE_PATH = resolve(homedir(), ".local", "bin", "claude");
const TMUX_SESSION_PREFIX = "claude-";

/**
 * Compute the runtime-dir path that holds the relay URL for a given project
 * cwd. Sanitises by stripping the leading `/` and replacing the remaining
 * slashes with underscores so each session's URL lives in its own file:
 *
 *   /Users/x/team_salary  →  ${RUNTIME_DIR}/claude-hub-supervisor/Users_x_team_salary.relay-url
 *
 * The same scheme is mirrored in `supervisor/hooks/progress-relay.sh`. If you
 * change the layout here, update the hook and its tests as well.
 *
 * Issue #88: keeps the file out of every project repo.
 */
export function relayUrlFilePath(projectDir: string): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || "/tmp";
  const sanitised = projectDir.replace(/^\/+/, "").replace(/\//g, "_");
  return `${runtimeDir}/claude-hub-supervisor/${sanitised}.relay-url`;
}

export interface SessionManagerOptions {
  /**
   * Inject side-effect adapters for tmux / iTerm2 / relay-server / process
   * signals. Tests pass fakes from {@link ./adapters-fake} so unit tests do
   * not spawn real tmux sessions or iTerm2 tabs (Issue #61). Production
   * leaves this undefined to use {@link realSessionEffects}.
   */
  effects?: Partial<SessionEffects>;
  /**
   * Override the graceful-kill wait so tests don't pay the production 15s
   * delay before kill-session. Defaults to {@link GRACEFUL_KILL_TIMEOUT_MS}.
   */
  gracefulKillTimeoutMs?: number;
}

export class SessionManager {
  /** Map<threadId, SessionInfo> — one session per thread */
  private sessions = new Map<string, SessionInfo>();
  /** Map<threadId, intervalHandle> — watchdogs to clear on stop/shutdown */
  private watchers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly effects: SessionEffects;
  private readonly gracefulKillTimeoutMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.effects = {
      tmux: options.effects?.tmux ?? realSessionEffects.tmux,
      iterm2: options.effects?.iterm2 ?? realSessionEffects.iterm2,
      relayServer:
        options.effects?.relayServer ?? realSessionEffects.relayServer,
      process: options.effects?.process ?? realSessionEffects.process,
    };
    this.gracefulKillTimeoutMs =
      options.gracefulKillTimeoutMs ?? GRACEFUL_KILL_TIMEOUT_MS;

    this.effects.tmux.ensureSocketConfigured();
    this.effects.relayServer.start();
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
    this.effects.tmux.killSession(tmuxName);

    // Build the claude command — unset ANTHROPIC_API_KEY to use Claude Max subscription
    const relayUrl = `http://localhost:${this.effects.relayServer.getPort()}/relay/${threadId}`;

    // Relay URL is written to a runtime-dir file keyed by the project cwd so
    // that progress-relay.sh (PostToolUse hook) can locate it from $CWD without
    // dropping `.supervisor-relay-url` into every project repo (Issue #88).
    // The hook applies the same sanitisation logic to its `$CWD` payload.
    const relayUrlFile = relayUrlFilePath(config.dir);
    const relayUrlDir = relayUrlFile.replace(/\/[^/]+$/, "");

    const claudeCmd = [
      "unset ANTHROPIC_API_KEY",
      `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
      `export SUPERVISOR_RELAY_URL="${relayUrl}"`,
      `mkdir -p "${relayUrlDir}"`,
      `printf "%s" "${relayUrl}" > "${relayUrlFile}"`,
      `cd "${config.dir}"`,
      `exec ${CLAUDE_PATH} --dangerously-skip-permissions --name "${config.channelName}"`,
    ].join(" && ");

    // Launch via tmux (provides a real TTY). Uses Supervisor's dedicated
    // -L claude-hub socket (see ./tmux.ts) so user config is not inherited.
    this.effects.tmux.newSession(tmuxName, claudeCmd);
    // Apply server-wide options now that the server is definitely running.
    // The constructor's eager call is a no-op before the first new-session.
    this.effects.tmux.ensureSocketConfigured();

    // Wait briefly for process to start
    let pid: number | null = null;
    for (let i = 0; i < 5; i++) {
      pid = this.effects.tmux.getPid(tmuxName);
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
      this.effects.iterm2.openTab({
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
    if (!this.effects.tmux.hasSession(tmuxName)) {
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
    this.effects.relayServer.cancel(threadId);
    const tmuxName = this.tmuxSessionName(threadId);

    console.log(
      `[SessionManager] Stopping ${session.channelName} in thread ${threadId} (reason: ${reason})`
    );

    // Send SIGTERM to the claude process
    try {
      this.effects.process.kill(session.pid, "SIGTERM");
    } catch {
      // Process already dead
    }

    // Wait for graceful shutdown, then force kill tmux session
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        this.effects.tmux.killSession(tmuxName);
        resolve();
      }, this.gracefulKillTimeoutMs);
    });

    this.clearWatcher(threadId);
    this.sessions.delete(threadId);
    this.effects.iterm2.markTabStopped(session.channelName, tmuxName);
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
    // Clear any remaining watchers (defensive — stop() already clears them).
    for (const handle of this.watchers.values()) {
      clearInterval(handle);
    }
    this.watchers.clear();
    this.effects.relayServer.stop();
    console.log("[SessionManager] All sessions stopped.");
  }

  private clearWatcher(threadId: string): void {
    const handle = this.watchers.get(threadId);
    if (handle) {
      clearInterval(handle);
      this.watchers.delete(threadId);
    }
  }

  private watchTmuxSession(
    threadId: string,
    tmuxName: string,
    sessionId: string
  ): void {
    const interval = setInterval(() => {
      if (!this.effects.tmux.hasSession(tmuxName)) {
        const session = this.sessions.get(threadId);
        console.log(
          `[SessionManager] tmux session ${tmuxName} exited`
        );
        this.sessions.delete(threadId);
        if (session) {
          this.effects.iterm2.markTabStopped(session.channelName, tmuxName);
        }
        updateSessionStatus(sessionId, "stopped", "tmux_exited");
        this.clearWatcher(threadId);
      }
    }, 10_000); // Check every 10 seconds
    this.watchers.set(threadId, interval);
  }

  private recoverFromDb(): void {
    const rows = getRunningSessions();
    for (const row of rows) {
      if (row.thread_id) {
        const tmuxName = this.tmuxSessionName(row.thread_id);
        if (this.effects.tmux.hasSession(tmuxName)) {
          console.log(
            `[SessionManager] Found running tmux session ${tmuxName}, killing (supervisor restart)`
          );
          this.effects.tmux.killSession(tmuxName);
        }
      }
      updateSessionStatus(row.id, "stopped", "supervisor_restart");
    }
  }
}
