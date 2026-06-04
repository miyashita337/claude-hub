import { randomUUID } from "crypto";
import { existsSync, unlinkSync } from "fs";
import { dirname, resolve } from "path";
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
  getSessionByClaudeSessionId,
  getSessionByThreadId,
  type SessionRow,
} from "../infra/db";
import {
  relayMessage,
  type AttachmentInfo,
  type RelayResult,
  type RelayMessageOptions,
} from "./relay";
import {
  realSessionEffects,
  type SessionEffects,
} from "./adapters";

const CLAUDE_PATH = resolve(homedir(), ".local", "bin", "claude");
const TMUX_SESSION_PREFIX = "claude-";

/**
 * Authoritative liveness verdict produced by {@link SessionManager.livenessOf}
 * (Issue #168). Single source of truth so salvage responses and resume guards
 * do not drift.
 *   - `alive`: DB running + pid alive + tmux session exists
 *   - `dead`: DB stopped, OR DB running but pid dead / tmux missing
 *   - `unknown`: no DB row for the thread (never observed)
 */
export type Liveness = "alive" | "dead" | "unknown";

/**
 * Claude session IDs are UUIDs. The resume flow embeds the id in the bash
 * command string passed to tmux, so restrict it to the UUID shape — a value
 * that fails this cannot carry shell metacharacters (Issue #161).
 */
const CLAUDE_SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Marker for Claude Code's interactive resume prompt
 * (`Resume from summary (recommended)` / `Resume the full conversation`),
 * shown when `claude --resume <id>` targets a compacted session. There is no
 * CLI flag to pre-select it (`claude --help`), so the resume flow polls the
 * pane for this marker and sends Enter (Issue #161).
 */
const RESUME_PROMPT_RE = /Resume (from summary|the full conversation)/i;
/**
 * Marker that the resumed TUI reached its normal input prompt — either a
 * non-compacted session that never shows the picker, or the picker has already
 * been dismissed. Lets the poll loop stop early instead of waiting out the full
 * window when there is nothing to confirm (Issue #163).
 */
const RESUME_READY_RE = /bypass permissions|\? for shortcuts/i;
/**
 * Poll attempts (×interval) to detect the resume prompt before giving up.
 * Large compacted sessions can take minutes to render the picker (observed
 * ~4min for a 239k-token / 1d21h session), so with the default 1s interval this
 * is a ~5min budget. The loop exits early as soon as the picker OR the ready
 * marker appears, so a small/non-compacted resume still returns in ~1s
 * (Issue #163 — a 12×0.5s=6s window timed out before the picker rendered).
 */
const RESUME_PROMPT_POLL_ATTEMPTS = 300;

/**
 * Build the argv for the `claude` invocation in a supervisor session.
 *
 * Issue #104 / Epic #101: by default supervisor sessions disable Chrome
 * integration and skip every user-scope MCP server, reclaiming 10-15s of
 * cold-start that nothing in the relay path needs. The flags here can be
 * relaxed per channel via {@link ChannelConfig.chromeEnabled} and
 * {@link ChannelConfig.mcpProfile}.
 *
 * Returned tokens are joined with single-space and embedded in a bash command
 * string downstream; callers must not append shell metacharacters that would
 * not survive that round-trip. Single-quoted JSON for `--mcp-config` is safe
 * because bash treats it as a single literal argument.
 */
export function buildClaudeFlags(config: ChannelConfig): string[] {
  const args = [
    "--dangerously-skip-permissions",
    "--name",
    `"${config.channelName}"`,
  ];

  if (config.chromeEnabled !== true) {
    args.push("--no-chrome");
  }

  const profile = config.mcpProfile ?? "none";
  if (profile === "none") {
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      `'{"mcpServers":{}}'`,
    );
  }

  return args;
}

/**
 * Compute the runtime-dir path that holds the relay URL for a given project
 * cwd. Sanitises by stripping every leading `/` and replacing any character
 * outside `[A-Za-z0-9._-]` with `_`, so each session's URL lives in its own
 * file and the path is shell-safe even if `projectDir` contains quotes:
 *
 *   /Users/x/team_salary  →  ${RUNTIME_DIR}/Users_x_team_salary.relay-url
 *
 * `XDG_RUNTIME_DIR` is per-user by spec (`/run/user/$UID`), so when present
 * we just append `claude-hub-supervisor`. When absent (typical macOS) we fall
 * back to `/tmp/claude-hub-supervisor-<USER>` to avoid multi-user mkdir
 * collisions on shared `/tmp`.
 *
 * The same scheme is mirrored in `supervisor/hooks/progress-relay.sh`. If you
 * change the layout here, update the hook and its tests as well.
 *
 * Issue #88: keeps the file out of every project repo.
 */
export function relayUrlFilePath(projectDir: string): string {
  const fromXdg = process.env.XDG_RUNTIME_DIR;
  const user = process.env.USER || "default";
  const runtimeDir = fromXdg
    ? `${fromXdg}/claude-hub-supervisor`
    : `/tmp/claude-hub-supervisor-${user}`;
  const sanitised = projectDir
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return `${runtimeDir}/${sanitised}.relay-url`;
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
  /**
   * Resume-prompt poll tuning (Issue #161). Tests shrink these so the
   * "no prompt" path doesn't pay the production ~6s wait. Defaults:
   * {@link RESUME_PROMPT_POLL_ATTEMPTS} attempts × 500ms.
   */
  resumePromptPollAttempts?: number;
  resumePromptPollIntervalMs?: number;
}

export class SessionManager {
  /** Map<threadId, SessionInfo> — one session per thread */
  private sessions = new Map<string, SessionInfo>();
  /** Map<threadId, intervalHandle> — watchdogs to clear on stop/shutdown */
  private watchers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly effects: SessionEffects;
  private readonly gracefulKillTimeoutMs: number;
  private readonly resumePromptPollAttempts: number;
  private readonly resumePromptPollIntervalMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.effects = {
      tmux: options.effects?.tmux ?? realSessionEffects.tmux,
      iterm2: options.effects?.iterm2 ?? realSessionEffects.iterm2,
      relayServer:
        options.effects?.relayServer ?? realSessionEffects.relayServer,
      process: options.effects?.process ?? realSessionEffects.process,
      worktree: options.effects?.worktree ?? realSessionEffects.worktree,
    };
    this.gracefulKillTimeoutMs =
      options.gracefulKillTimeoutMs ?? GRACEFUL_KILL_TIMEOUT_MS;
    this.resumePromptPollAttempts =
      options.resumePromptPollAttempts ?? RESUME_PROMPT_POLL_ATTEMPTS;
    this.resumePromptPollIntervalMs =
      options.resumePromptPollIntervalMs ?? 1000;

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

  /**
   * Authoritative liveness for the given thread (Issue #168 / Epic #166).
   * Crosses DB `status` with reality — `process.kill(pid, 0)` for the recorded
   * pid, and tmux session existence — and returns a single `alive | dead |
   * unknown` verdict. Salvage responses and resume guards share this verdict so
   * callers cannot drift from each other.
   *
   * Behaviour matrix:
   *   - no DB row for the thread                        → `unknown`
   *   - row.status !== "running"                        → `dead`
   *   - row.status === "running" + no pid recorded     → `dead`
   *   - row.status === "running" + pid alive + tmux alive → `alive`
   *   - row.status === "running" + (pid dead OR tmux missing) → `dead`
   *     (DB says running but reality contradicts — answer is the reality)
   */
  livenessOf(threadId: string): Liveness {
    const row = getSessionByThreadId(threadId);
    if (!row) return "unknown";
    if (row.status !== "running") return "dead";
    if (row.pid == null) return "dead";
    const pidAlive = this.effects.process.isAlive(row.pid);
    const tmuxAlive = this.effects.tmux.hasSession(
      this.tmuxSessionName(threadId)
    );
    return pidAlive && tmuxAlive ? "alive" : "dead";
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
   *
   * Issue #154: when `branch` is given the session runs in a dedicated git
   * worktree under `<config.dir>/.claude/worktrees/<branch>` instead of the
   * channel's main worktree, isolating its working tree from other sessions on
   * the same repo. Without a branch the behaviour is unchanged (cwd = config.dir).
   */
  async start(
    config: ChannelConfig,
    threadId: string,
    branch?: string
  ): Promise<SessionInfo> {
    // Ordering guarantee (Issue #99): although start() is now async, the
    // duplicate/limit guards below through the first `await` (the PID-poll
    // sleep) run synchronously in one microtask, so the single-process Discord
    // bot's event loop cannot interleave a second start() between this check
    // and the `this.sessions.set` registration further down. No new race is
    // introduced by the sync→async change.
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

    // Issue #154: resolve the effective cwd. With a branch, create/reuse a
    // worktree (Q1/Q2/Q4 in worktree.ts); failures propagate so the caller can
    // report them rather than starting claude in the wrong directory.
    let projectDir = config.dir;
    let worktree: SessionInfo["worktree"];
    const trimmedBranch = branch?.trim();
    if (trimmedBranch) {
      const result = this.effects.worktree.ensure(config.dir, trimmedBranch);
      projectDir = result.path;
      worktree = {
        mainRepoDir: config.dir,
        path: result.path,
        branch: trimmedBranch,
      };
      console.log(
        `[SessionManager] ${result.reused ? "Reusing existing worktree" : "Created worktree"} for branch '${trimmedBranch}': ${result.path}`
      );
    }

    const sessionId = randomUUID();
    // Pre-generate the Claude session id and pin it via `claude --session-id`
    // so the DB row captures it deterministically at start (Issue #167).
    // The previous opportunistic capture (relay round-trip in bot.ts) left
    // ~90% of rows NULL because relays time out before reporting the id; that
    // path is now an idempotent fallback (only sets when still NULL).
    const claudeSessionId = randomUUID();
    const tmuxName = this.tmuxSessionName(threadId);

    // Kill existing tmux session if any
    this.effects.tmux.killSession(tmuxName);

    // Build the claude command — unset ANTHROPIC_API_KEY to use Claude Max subscription
    // encodeURIComponent: Discord thread IDs are numeric today, but encode at
    // the boundary so any future schema change (or fuzzed input) cannot break
    // the relay URL parser. relay-server.ts decodes symmetrically on receipt.
    const relayUrl = `http://localhost:${this.effects.relayServer.getPort()}/relay/${encodeURIComponent(threadId)}`;

    // Relay URL is written to a runtime-dir file keyed by the project cwd so
    // that progress-relay.sh (PostToolUse hook) can locate it from $CWD without
    // dropping `.supervisor-relay-url` into every project repo (Issue #88).
    // The hook applies the same sanitisation logic to its `$CWD` payload.
    const relayUrlFile = relayUrlFilePath(projectDir);
    const relayUrlDir = dirname(relayUrlFile);

    // Best-effort cleanup of any stale relay-url file from a prior session for
    // this project. Without this, a Supervisor restart can leave a file pointing
    // at a dead relay port; PostToolUse hooks would then POST to a stale URL
    // and silently time out (curl --max-time 3 in progress-relay.sh).
    this.cleanupRelayUrlFile(projectDir);

    const claudeCmd = [
      "unset ANTHROPIC_API_KEY",
      `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
      `export SUPERVISOR_RELAY_URL="${relayUrl}"`,
      `mkdir -p "${relayUrlDir}"`,
      `printf "%s" "${relayUrl}" > "${relayUrlFile}"`,
      `cd "${projectDir}"`,
      // `--session-id <uuid>` only on fresh start; resume uses `--resume <id>`
      // (the two are mutually exclusive). claudeSessionId is a randomUUID() so
      // it is shell-safe to embed here.
      `exec ${CLAUDE_PATH} --session-id ${claudeSessionId} ${buildClaudeFlags(config).join(" ")}`,
    ].join(" && ");

    // Launch via tmux (provides a real TTY). Uses Supervisor's dedicated
    // -L claude-hub socket (see ./tmux.ts) so user config is not inherited.
    this.effects.tmux.newSession(tmuxName, claudeCmd);
    // Apply server-wide options now that the server is definitely running.
    // The constructor's eager call is a no-op before the first new-session.
    this.effects.tmux.ensureSocketConfigured();

    // Wait briefly for process to start. start() is async (Issue #99) so this
    // uses a non-blocking setTimeout instead of the previous
    // `execSync("sleep 0.5")`, which spawned a shell per iteration and blocked
    // the single-process Discord bot's event loop. Mirrors resumeSession().
    let pid: number | null = null;
    for (let i = 0; i < 5; i++) {
      pid = this.effects.tmux.getPid(tmuxName);
      if (pid) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!pid) {
      // Claude failed to come up. Drop the relay-url file the in-tmux command
      // may have written so a PostToolUse hook never POSTs to a dead port. The
      // worktree (if any) is left in place — it is valid and gets reused on the
      // next `/session start <branch>` (Q4); only an explicit /session stop
      // removes it (Q3).
      this.cleanupRelayUrlFile(projectDir);
      throw new Error(
        "Claude Code の起動に失敗しました（tmuxセッションのPID取得失敗）"
      );
    }

    const now = new Date();
    const info: SessionInfo = {
      id: sessionId,
      channelName: config.channelName,
      threadId,
      projectDir,
      pid,
      claudeSessionId,
      process: null as unknown as any, // tmux manages the process
      startedAt: now,
      lastActivityAt: now,
      status: "running",
      branch: trimmedBranch || undefined,
      worktree,
    };

    this.sessions.set(threadId, info);

    insertSession({
      id: sessionId,
      channel_name: config.channelName,
      thread_id: threadId,
      project_dir: projectDir,
      pid,
      claude_session_id: claudeSessionId,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      status: "running",
      branch: trimmedBranch ?? null,
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
        projectDir,
      });
    }, 0);

    return info;
  }

  /**
   * Look up a stopped (or any) session by its Claude session id so the caller
   * can validate it before resuming. Returns the most recent matching row, or
   * undefined when the id is unknown (Issue #161).
   */
  findResumableSession(claudeSessionId: string): SessionRow | undefined {
    return getSessionByClaudeSessionId(claudeSessionId);
  }

  /**
   * Resume a previously-stopped Claude session in a fresh thread with full
   * relay wiring (Issue #161). Unlike {@link start}, this passes
   * `claude --resume <id>` so the conversation history is preserved.
   *
   * `projectDir` MUST be the directory the original session ran in (recorded in
   * sessions.db): `claude --resume` keys the transcript by cwd, so resuming
   * from any other directory — including a `-w` worktree — fails to find the
   * jsonl. Worktree re-creation is intentionally out of scope; a missing
   * `projectDir` throws so the caller can report it instead of silently
   * starting a fresh conversation.
   */
  async resumeSession(
    config: ChannelConfig,
    threadId: string,
    claudeSessionId: string,
    projectDir: string,
    branch?: string | null
  ): Promise<SessionInfo> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`最大セッション数 (${MAX_SESSIONS}) に達しています`);
    }
    if (this.sessions.has(threadId)) {
      throw new Error(`このスレッドのセッションは既に稼働中です`);
    }
    if (!CLAUDE_SESSION_ID_RE.test(claudeSessionId)) {
      throw new Error(
        `claude session id の形式が不正です: ${claudeSessionId}`
      );
    }
    if (!existsSync(projectDir)) {
      throw new Error(
        `プロジェクトディレクトリが見つかりません: ${projectDir}（worktree が削除された可能性があります）`
      );
    }

    const sessionId = randomUUID();
    const tmuxName = this.tmuxSessionName(threadId);
    this.effects.tmux.killSession(tmuxName);

    const relayUrl = `http://localhost:${this.effects.relayServer.getPort()}/relay/${encodeURIComponent(threadId)}`;
    const relayUrlFile = relayUrlFilePath(projectDir);
    const relayUrlDir = dirname(relayUrlFile);
    this.cleanupRelayUrlFile(projectDir);

    // `--resume <id>` continues the prior conversation in-place (no
    // --fork-session, so the same claude session id keeps accumulating).
    // claudeSessionId is validated as a UUID above, so embedding it in the
    // bash string is shell-safe. The command is passed to tmux via execFileSync
    // (argv) in the adapter, so it is not subject to outer-shell parsing.
    const resumeFlags = [
      "--resume",
      claudeSessionId,
      ...buildClaudeFlags(config),
    ];
    const claudeCmd = [
      "unset ANTHROPIC_API_KEY",
      `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
      `export SUPERVISOR_RELAY_URL="${relayUrl}"`,
      `mkdir -p "${relayUrlDir}"`,
      `printf "%s" "${relayUrl}" > "${relayUrlFile}"`,
      `cd "${projectDir}"`,
      `exec ${CLAUDE_PATH} ${resumeFlags.join(" ")}`,
    ].join(" && ");

    this.effects.tmux.newSession(tmuxName, claudeCmd);
    this.effects.tmux.ensureSocketConfigured();

    let pid: number | null = null;
    for (let i = 0; i < 5; i++) {
      pid = this.effects.tmux.getPid(tmuxName);
      if (pid) break;
      // Async wait — resumeSession is async, so unlike start()'s synchronous
      // execSync("sleep") this does not block the single-process Discord bot's
      // event loop while the tmux pane spins up (PR #162 review: gemini medium).
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!pid) {
      this.cleanupRelayUrlFile(projectDir);
      throw new Error(
        "Claude Code の起動に失敗しました（tmuxセッションのPID取得失敗）"
      );
    }

    const now = new Date();
    const info: SessionInfo = {
      id: sessionId,
      channelName: config.channelName,
      threadId,
      projectDir,
      pid,
      process: null as unknown as any, // tmux manages the process
      claudeSessionId,
      startedAt: now,
      lastActivityAt: now,
      status: "running",
      // No worktree on resume (runs in the project dir), but keep the branch so
      // same-branch counting and the thread title stay consistent (Issue #175).
      branch: branch || undefined,
    };

    // Post-launch init (prompt confirm + state registration) can throw. tmux is
    // already running by now, so on failure we must kill it and drop the
    // relay-url file — otherwise Discord reports failure while a Claude/tmux
    // process is left orphaned (PR #162 review: CodeRabbit Major).
    try {
      // Auto-confirm the interactive "Resume from summary" prompt if it appears.
      // Awaited (not fire-and-forget) so the session is registered only AFTER the
      // TUI reaches its normal input prompt — see the ordering note below.
      await this.confirmResumePromptIfPresent(tmuxName);

      this.sessions.set(threadId, info);

      insertSession({
        id: sessionId,
        channel_name: config.channelName,
        thread_id: threadId,
        project_dir: projectDir,
        pid,
        claude_session_id: claudeSessionId,
        started_at: now.toISOString(),
        last_activity_at: now.toISOString(),
        status: "running",
        // Carry the original session's branch (Issue #175) so the resumed
        // thread title and any later /session list stay branch-consistent.
        branch: branch ?? null,
      });
    } catch (err) {
      this.sessions.delete(threadId);
      this.effects.tmux.killSession(tmuxName);
      this.cleanupRelayUrlFile(projectDir);
      throw err;
    }

    this.watchTmuxSession(threadId, tmuxName, sessionId);

    console.log(
      `[SessionManager] Resumed ${config.channelName} (claude session ${claudeSessionId}) via tmux (PID: ${pid}, tmux: ${tmuxName}, thread: ${threadId})`
    );

    setTimeout(() => {
      this.effects.iterm2.openTab({
        tmuxSessionName: tmuxName,
        channelName: config.channelName,
        projectDir,
      });
    }, 0);

    return info;
  }

  /**
   * Poll the pane for Claude Code's "Resume from summary" prompt and select
   * option 2 "Resume full session as-is" (Down then Enter). The picker
   * highlights option 1 "Resume from summary (recommended)" by default, but we
   * always want the full conversation, not a summary (Issue #163), so we move
   * the selection down one before confirming. Marker-based rather than a fixed
   * sleep (RW-025/027): if the marker never appears the session resumed without
   * a prompt (a non-compacted session resumes full directly) and we proceed
   * without sending stray keys.
   *
   * The wait between polls uses an awaited `setTimeout`, not a synchronous
   * `execSync("sleep")`, so the single-process Discord bot's event loop stays
   * free while polling (PR #162 review: a synchronous sleep would block all
   * other channels' relays for up to ~6s). The caller awaits this method, so
   * the non-blocking change does NOT weaken the ordering guarantee — the
   * session is still registered only after the prompt is confirmed, so a
   * relayed message can never race the prompt picker (#86 / RW-019 class bug).
   */
  private async confirmResumePromptIfPresent(tmuxName: string): Promise<void> {
    for (let i = 0; i < this.resumePromptPollAttempts; i++) {
      const pane = this.effects.tmux.capturePane(tmuxName);
      if (RESUME_PROMPT_RE.test(pane)) {
        // Down moves from option 1 (summary, highlighted) to option 2 (full
        // session as-is); C-m confirms. See Issue #163.
        this.effects.tmux.sendKeys(tmuxName, ["Down", "C-m"]);
        return;
      }
      // Reached the normal input prompt with no picker — stop polling instead
      // of waiting out the (multi-minute) window for a picker that won't appear
      // (Issue #163). Checked after the picker so the picker always wins.
      if (RESUME_READY_RE.test(pane)) {
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.resumePromptPollIntervalMs)
      );
    }
  }

  /**
   * Send a message to the Claude Code session via tmux and get the response.
   *
   * Issue #57: `onDialogStuck` is forwarded to the relay's dialog watchdog;
   * if a dialog (Plan / AskUserQuestion / MCP elicitation / Bash y/n) slips
   * past `--dangerously-skip-permissions` and resists auto-accept, the
   * callback runs so the Discord layer can post a heartbeat to the thread.
   */
  async sendMessage(
    threadId: string,
    message: string,
    attachments?: AttachmentInfo[],
    options?: Pick<RelayMessageOptions, "onDialogStuck">
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

    return relayMessage(tmuxName, threadId, message, {
      attachments,
      onDialogStuck: options?.onDialogStuck,
    });
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
    this.cleanupRelayUrlFile(session.projectDir);

    // Issue #154 (Q3): remove the per-branch worktree on stop; the branch is
    // preserved. But Q4 allows multiple sessions to share one worktree (同
    // branch 多重 session). `this.sessions` no longer contains the current
    // thread (deleted above), so if any *other* running session still points
    // at this worktree path, removing it would destroy that live session's
    // cwd. Only the last session on the worktree removes it (PR #157 review,
    // CodeRabbit Major).
    if (session.worktree && !this.isWorktreePathInUse(session.worktree.path)) {
      this.removeWorktreeBestEffort(session.worktree);
    } else if (session.worktree) {
      console.log(
        `[SessionManager] Worktree ${session.worktree.path} still in use by another session; not removing`
      );
    }
  }

  /** True if a still-running session (other than the one just removed) uses this worktree path. */
  private isWorktreePathInUse(worktreePath: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.worktree?.path === worktreePath) return true;
    }
    return false;
  }

  /**
   * Remove a session's worktree, swallowing failures (Issue #154, Q3). A stuck
   * worktree must never block session teardown, so a removal error is logged
   * and ignored. No-op when the session had no worktree.
   */
  private removeWorktreeBestEffort(
    worktree: SessionInfo["worktree"]
  ): void {
    if (!worktree) return;
    try {
      this.effects.worktree.remove(worktree.mainRepoDir, worktree.path);
      console.log(
        `[SessionManager] Removed worktree ${worktree.path} (branch '${worktree.branch}' preserved)`
      );
    } catch (err) {
      console.warn(
        `[SessionManager] Failed to remove worktree ${worktree.path}:`,
        err
      );
    }
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
          this.cleanupRelayUrlFile(session.projectDir);
          // Issue #154: the worktree is intentionally NOT removed here. An
          // unexpected claude exit is not an explicit teardown — removing the
          // worktree (git worktree remove --force) would discard any
          // uncommitted work the user did not choose to drop. Only the explicit
          // /session stop removes it (Q3); until then it is reused on restart
          // of the same branch (Q4).
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
      this.cleanupRelayUrlFile(row.project_dir);
      // Issue #154: worktrees are intentionally left in place on restart. They
      // are reused on the next `/session start <branch>` (Q4) and force-removing
      // them here would discard uncommitted work without an explicit teardown.
      // Only /session stop removes a worktree (Q3).
      updateSessionStatus(row.id, "stopped", "supervisor_restart");
    }
  }

  /**
   * Best-effort removal of the relay-url file for a project. Idempotent: ENOENT
   * is treated as success (already cleaned). Called from start (before write),
   * stop (after sessions.delete), watchTmuxSession (on tmux_exited), and
   * recoverFromDb (Supervisor restart) so a dead URL never lingers and gets
   * POSTed to by progress-relay.sh.
   */
  private cleanupRelayUrlFile(projectDir: string): void {
    const relayUrlFile = relayUrlFilePath(projectDir);
    try {
      unlinkSync(relayUrlFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[SessionManager] Failed to unlink stale relay-url ${relayUrlFile}:`,
          err
        );
      }
    }
  }
}
