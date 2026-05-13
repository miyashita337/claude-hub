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
}

export interface SessionEffects {
  tmux: TmuxAdapter;
  iterm2: ItermAdapter;
  relayServer: RelayServerAdapter;
  process: ProcessAdapter;
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
};

export const realSessionEffects: SessionEffects = {
  tmux: realTmuxAdapter,
  iterm2: realItermAdapter,
  relayServer: realRelayServerAdapter,
  process: realProcessAdapter,
};
