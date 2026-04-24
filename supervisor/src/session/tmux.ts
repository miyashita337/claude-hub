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
 */
export const TMUX_SOCKET = process.env.SUPERVISOR_TMUX_SOCKET ?? "claude-hub";

/** argv prefix for all execFileSync tmux calls. */
export const TMUX_ARGS: readonly string[] = ["-L", TMUX_SOCKET];

/**
 * Shell fragment for template-string execSync calls. The socket name is a
 * fixed identifier (no user input) so interpolating it directly is safe.
 */
export const TMUX_CMD = `${TMUX_PATH} -L ${TMUX_SOCKET}`;

let socketConfigured = false;

/**
 * Apply the global options required on the Supervisor's dedicated tmux
 * server. Idempotent — the first call implicitly starts the server if it is
 * not running. Subsequent calls are cheap (early return).
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
  if (socketConfigured) return;
  try {
    execSync(`${TMUX_CMD} set-option -g mouse off`, { timeout: 3000, stdio: "pipe" });
    execSync(`${TMUX_CMD} set-option -g mode-keys emacs`, { timeout: 3000, stdio: "pipe" });
    execSync(`${TMUX_CMD} set-option -g history-limit 10000`, { timeout: 3000, stdio: "pipe" });
    socketConfigured = true;
  } catch (err) {
    // Expected on the first call: the tmux server is not yet up (no session
    // has been created), so `set-option -g` fails with `no server running`.
    // Our caller (SessionManager.start) invokes this again after
    // `new-session -d`, at which point the server is up and options stick.
    // Any other error (disk full, /tmp perms) will also surface on retry.
    const msg = err instanceof Error ? err.message : String(err);
    const isNoServer = /no server running/i.test(msg);
    if (!isNoServer) {
      console.warn("[tmux] ensureSocketConfigured failed:", err);
    }
  }
}
