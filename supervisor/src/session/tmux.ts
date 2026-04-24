import { execSync } from "child_process";

export const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";

/**
 * Dedicated tmux socket for Supervisor-managed sessions.
 *
 * Using a dedicated -L socket isolates Supervisor from the user's
 * ~/.tmux.conf, which in practice has `mouse on`, `mode-keys vi`, and a
 * WheelUpPane binding that auto-enters `copy-mode -e` when the pane is not
 * already in a mode. That combination creates the race where mouse wheel
 * events (real or momentum) re-enter copy-mode in the window between
 * `ensurePaneNotInMode` and the next `send-keys`, causing `send-keys -l` to
 * fail with `not in a mode` and silently drop user messages (Issue #73).
 *
 * The socket name is validated against a safe character class so that
 * `SUPERVISOR_TMUX_SOCKET` (an env var an operator may set) cannot inject
 * shell metacharacters into `TMUX_CMD`'s template-string interpolation.
 */
const SOCKET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const rawSocket = process.env.SUPERVISOR_TMUX_SOCKET ?? "claude-hub";
if (!SOCKET_NAME_PATTERN.test(rawSocket)) {
  throw new Error(
    `Invalid SUPERVISOR_TMUX_SOCKET: ${JSON.stringify(rawSocket)}. ` +
      `Allowed characters: [A-Za-z0-9_.-]`
  );
}
export const TMUX_SOCKET = rawSocket;

/** argv prefix for all execFileSync tmux calls. */
export const TMUX_ARGS: readonly string[] = ["-L", TMUX_SOCKET];

/**
 * Shell fragment for template-string execSync calls. Safe because
 * `TMUX_SOCKET` has been validated against `SOCKET_NAME_PATTERN`.
 */
export const TMUX_CMD = `${TMUX_PATH} -L ${TMUX_SOCKET}`;

/**
 * Apply the global options required on the Supervisor's dedicated tmux
 * server. Idempotent — `set-option -g` is cheap and re-applying does no
 * harm, so this intentionally has no memoisation flag: the options are
 * re-applied on every session start, which makes Supervisor resilient to
 * the tmux server being restarted (manually or after a crash) within the
 * same Supervisor process lifetime.
 *
 * The three options are chained into a single tmux invocation via the
 * `\;` command separator so that we spawn one process instead of three.
 *
 * On the very first call there is no tmux server yet, so the chained
 * command fails with `no server running` — that is expected. Our caller
 * (`SessionManager.start`) invokes this again after `new-session -d`,
 * at which point the server is up and the options stick. Any other
 * failure (disk full, /tmp perms, etc.) is logged as a warning.
 *
 * Options set:
 * - `mouse off`: prevents WheelUpPane from auto-entering copy-mode (H1).
 * - `mode-keys emacs`: `Escape` cancels copy-mode when in one (in contrast
 *   to vi, where Escape is a no-op on the mode). This protects the Ink
 *   modal-clear behaviour in `relay.ts` even in the defensive path.
 * - `history-limit 10000`: matches the prior per-session setting and keeps
 *   scrollback bounded to avoid iTerm2 freezes on heavy TUI output.
 *
 * @see docs: Issue #73 / Epic #79 / Sub #80 (H1) / Sub #81 (H2)
 */
export function ensureSocketConfigured(): void {
  try {
    execSync(
      `${TMUX_CMD} set-option -g mouse off \\; ` +
        `set-option -g mode-keys emacs \\; ` +
        `set-option -g history-limit 10000`,
      { timeout: 3000, stdio: "pipe" }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNoServer = /no server running/i.test(msg);
    if (!isNoServer) {
      console.warn("[tmux] ensureSocketConfigured failed:", err);
    }
  }
}
