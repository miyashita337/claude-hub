import { execFile } from "child_process";
import { TMUX_PATH } from "./tmux";
import { sendToPane } from "./relay";

/**
 * Issue #199 AC1 — compact the claudeHubExit primary-channel session.
 *
 * claudeHubExit runs in a tmux session named `claudeHubExit` on the DEFAULT
 * tmux socket (`start-hijoguchi.sh` calls `tmux new-session` with no `-L`),
 * which is a different tmux server than the Supervisor's dedicated `-L
 * claude-hub` socket. This module is the single sanctioned place where the
 * Supervisor reaches across that socket boundary, and only to relay a
 * user-initiated `/session compact` keystroke — it never manages that
 * session's lifecycle, preserving the claudeHubExit independence boundary
 * documented in CLAUDE.md / docs/bot-operations.md.
 */

/** Tmux session name created by start-hijoguchi.sh (SESSION=claudeHubExit). */
export const CLAUDEHUBEXIT_TMUX_SESSION = "claudeHubExit";

/** Empty socket args select the DEFAULT tmux socket (no `-L`). */
const DEFAULT_SOCKET_ARGS: readonly string[] = [];

/**
 * True iff the claudeHubExit tmux session is alive on the default socket.
 * Best-effort: any tmux error (no server running / no such session) is treated
 * as "dead". The session name is a hard-coded constant, so there is no shell
 * injection surface even though this spawns tmux directly.
 *
 * Async (execFile, not execFileSync) so the 2 s probe never blocks the
 * Supervisor's single Discord event loop if tmux is slow to respond
 * (gemini-code-assist review on #213).
 */
export function claudeHubExitSessionAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      TMUX_PATH,
      ["has-session", "-t", CLAUDEHUBEXIT_TMUX_SESSION],
      { timeout: 2000 },
      (err) => resolve(!err)
    );
  });
}

/**
 * Relay `/compact <intent>` to the claudeHubExit session on the default socket.
 *
 * Throws `"claudeHubExit session dead"` when the session is absent so the
 * command layer surfaces an ephemeral error instead of silently dropping keys
 * (#199 AC3 parity with the thread-bound path). RW-032: refuse an empty intent
 * — the command layer always substitutes a default, so an empty value here can
 * only be a programming error. The send sequence reuses {@link sendToPane}
 * (mode-exit / Escape / `send-keys -l` / `C-m`) so the battle-tested,
 * injection-safe relay path is the single source of truth (RW-019/045/047).
 */
export async function compactClaudeHubExit(intent: string): Promise<void> {
  if (!intent.trim()) {
    throw new Error("compact intent must be non-empty (RW-032)");
  }
  // Pre-flight liveness probe. There is a benign TOCTOU vs the send below (the
  // session could die in the gap), but sendToPane would then throw anyway and
  // the command layer surfaces it the same way — so this only upgrades the
  // user-facing message to a clear "session dead" instead of a raw tmux error.
  // Worth one extra cross-socket RTT on a manual, infrequent command.
  if (!(await claudeHubExitSessionAlive())) {
    throw new Error("claudeHubExit session dead");
  }
  await sendToPane(
    CLAUDEHUBEXIT_TMUX_SESSION,
    `/compact ${intent}`,
    DEFAULT_SOCKET_ARGS
  );
}
