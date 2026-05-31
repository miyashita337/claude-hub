import { execFileSync } from "child_process";
import {
  openTab as realOpenTab,
  markTabStopped as realMarkTabStopped,
  type OpenTabOptions,
} from "./iterm2";
import {
  startRelayServer as realStartRelayServer,
  stopRelayServer as realStopRelayServer,
  getRelayPort as realGetRelayPort,
  cancelRelay as realCancelRelay,
} from "./relay-server";
import {
  TMUX_ARGS,
  TMUX_PATH,
  ensureSocketConfigured as realEnsureSocketConfigured,
} from "./tmux";
import {
  ensureWorktree,
  removeWorktree,
  realGitGhRunner,
  type EnsureWorktreeResult,
} from "./worktree";

/**
 * Adapters that wrap external side effects (tmux, iTerm2, relay HTTP server,
 * OS process signals). The {@link SessionManager} uses this indirection so
 * unit tests can inject in-memory fakes and avoid spawning real tmux sessions
 * or iTerm2 tabs (Issue #61).
 */

export interface TmuxAdapter {
  newSession(name: string, command: string): void;
  killSession(name: string): void;
  hasSession(name: string): boolean;
  getPid(name: string): number | null;
  ensureSocketConfigured(): void;
  /**
   * Capture the visible pane content (`tmux capture-pane -p`). Returns "" on
   * error. Used by the resume flow (Issue #161) to detect Claude Code's
   * interactive "Resume from summary" prompt so it can be auto-confirmed.
   */
  capturePane(name: string): string;
  /**
   * Send raw keys to the pane (`tmux send-keys -t <name> <keys...>`).
   * Best-effort: a transient failure is swallowed (the caller's poll loop
   * retries or proceeds). Used to confirm the resume prompt with `C-m` (Enter).
   */
  sendKeys(name: string, keys: string[]): void;
}

export interface ItermAdapter {
  openTab(opts: OpenTabOptions): void;
  markTabStopped(channelName: string, tmuxSessionName?: string): void;
}

export interface RelayServerAdapter {
  start(): void;
  stop(): void;
  getPort(): number;
  cancel(threadId: string): void;
}

export interface ProcessAdapter {
  kill(pid: number, signal: NodeJS.Signals | number): void;
  /**
   * Best-effort liveness check for a pid. Used by {@link SessionManager} to
   * cross-check DB `status='running'` against reality (Issue #168). Returns
   * `true` when the process exists (or exists but we lack signal permission —
   * EPERM), `false` when it has exited (ESRCH). Never throws.
   */
  isAlive(pid: number): boolean;
}

/**
 * Per-branch git worktree management (Issue #154). Real impl delegates to
 * {@link ./worktree} with the production git/gh runner; tests inject an
 * in-memory fake so {@link SessionManager} unit tests never run git.
 */
export interface WorktreeAdapter {
  /** Create or reuse the worktree for `branch` under `mainRepoDir`. */
  ensure(mainRepoDir: string, branch: string): EnsureWorktreeResult;
  /** Remove the worktree (branch is preserved). */
  remove(mainRepoDir: string, worktreePath: string): void;
}

export interface SessionEffects {
  tmux: TmuxAdapter;
  iterm2: ItermAdapter;
  relayServer: RelayServerAdapter;
  process: ProcessAdapter;
  worktree: WorktreeAdapter;
}

export const realTmuxAdapter: TmuxAdapter = {
  newSession(name, command) {
    // Issue #147: previous `execSync(\`tmux new-session ... '${command}'\`)`
    // wrapped the entire command in single quotes. When `command` itself
    // contained single quotes (e.g. `--mcp-config '{"mcpServers":{}}'` added
    // in #104), the outer quotes closed prematurely, exposing the inner JSON
    // to bash word-splitting and quote stripping — claude received malformed
    // arguments and exited immediately. Using execFileSync with an argv array
    // avoids shell parsing entirely: tmux receives `command` as a single
    // argument and invokes /bin/sh -c on it once, inside the new session.
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "new-session", "-d", "-s", name, command]);
  },
  killSession(name) {
    // PR #148 review (gemini critical): use execFileSync + argv array so an
    // attacker-controlled `name` cannot inject shell metacharacters via the
    // template literal. `stdio: "ignore"` matches the previous `2>/dev/null`
    // (silence the expected "no session" error).
    try {
      execFileSync(TMUX_PATH, [...TMUX_ARGS, "kill-session", "-t", name], {
        stdio: "ignore",
      });
    } catch {
      // No existing session
    }
  },
  hasSession(name) {
    try {
      execFileSync(TMUX_PATH, [...TMUX_ARGS, "has-session", "-t", name], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  },
  getPid(name) {
    // stdio: ["ignore", "pipe", "ignore"] — we need stdout to read the pid,
    // but stderr is discarded just like the previous `2>/dev/null`.
    try {
      const output = execFileSync(
        TMUX_PATH,
        [...TMUX_ARGS, "list-panes", "-t", name, "-F", "#{pane_pid}"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      const pid = parseInt(output.split("\n")[0] ?? "", 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  },
  ensureSocketConfigured() {
    realEnsureSocketConfigured();
  },
  capturePane(name) {
    // stdio: ["ignore", "pipe", "ignore"] — read stdout, discard stderr (the
    // "can't find pane" case is handled by the catch returning "").
    try {
      return execFileSync(
        TMUX_PATH,
        [...TMUX_ARGS, "capture-pane", "-p", "-t", name],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch {
      return "";
    }
  },
  sendKeys(name, keys) {
    // execFileSync + argv array: no shell, so `keys` cannot inject
    // metacharacters. Best-effort — swallow transient tmux errors.
    try {
      execFileSync(TMUX_PATH, [...TMUX_ARGS, "send-keys", "-t", name, ...keys], {
        stdio: "ignore",
      });
    } catch {
      // Caller's poll loop retries or proceeds.
    }
  },
};

export const realItermAdapter: ItermAdapter = {
  openTab(opts) {
    realOpenTab(opts);
  },
  markTabStopped(channelName, tmuxSessionName) {
    realMarkTabStopped(channelName, tmuxSessionName);
  },
};

export const realRelayServerAdapter: RelayServerAdapter = {
  start: realStartRelayServer,
  stop: realStopRelayServer,
  getPort: realGetRelayPort,
  cancel: realCancelRelay,
};

export const realProcessAdapter: ProcessAdapter = {
  kill(pid, signal) {
    process.kill(pid, signal);
  },
  isAlive(pid) {
    // `kill(pid, 0)` is the POSIX convention for liveness checks: it performs
    // permission/existence resolution without sending a signal. ESRCH means
    // the process no longer exists; EPERM means it exists but the calling
    // process can't signal it — still alive for our purposes (Issue #168).
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return e.code === "EPERM";
    }
  },
};

export const realWorktreeAdapter: WorktreeAdapter = {
  ensure(mainRepoDir, branch) {
    return ensureWorktree(mainRepoDir, branch, realGitGhRunner);
  },
  remove(mainRepoDir, worktreePath) {
    removeWorktree(mainRepoDir, worktreePath, realGitGhRunner);
  },
};

export const realSessionEffects: SessionEffects = {
  tmux: realTmuxAdapter,
  iterm2: realItermAdapter,
  relayServer: realRelayServerAdapter,
  process: realProcessAdapter,
  worktree: realWorktreeAdapter,
};
