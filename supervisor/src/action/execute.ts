import { execFile } from "child_process";
import { promisify } from "util";
import { realpathSync } from "fs";
import { resolve } from "path";
import { TMUX_PATH, TMUX_ARGS } from "../session/tmux";

const execFileAsync = promisify(execFile);

/**
 * Layer 4 — execution adapter for Pushover one-tap actions (Issue #305, spec §6).
 *
 * `executeAction(action, target)` is the single entry point. Adding an action is
 * two edits: a member in {@link ALLOWED_ACTIONS} and a `case` in the switch
 * below. The receiver (layer 3) has already verified the token's signature, TTL,
 * allowlist membership, and nonce before calling here — but the switch's
 * `default` still rejects any non-allowlisted action, so an arbitrary command is
 * structurally unexecutable even if the pipeline is bypassed (spec §8 defence 3).
 *
 * All external effects (session lookup, key send) are injected via
 * {@link ExecuteDeps} / {@link SessionResolveDeps} so this module stays pure and
 * unit-testable without a real DB or tmux. Production wiring lives in ./receiver.
 */

/**
 * Actions the receiver may execute. Completeness with the {@link executeAction}
 * switch is the contract: a member here without a `case` would resolve the
 * session then fall through to `disallowed_action` (fail-closed, not silent).
 */
export const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(["compact"]);

export function isActionAllowed(action: string): boolean {
  return ALLOWED_ACTIONS.has(action);
}

/**
 * Intent appended to the one-tap `/compact`. A bare `/compact` produces a poor
 * summary because the model cannot predict the next work direction (RW-032), so
 * every compact — interactive (commands/session.ts `DEFAULT_COMPACT_INTENT`) or
 * one-tap — carries an explicit intent. Kept as a local constant to keep this
 * layer decoupled from the Discord command layer.
 */
export const ONE_TAP_COMPACT_INTENT = "直近の作業状態と次アクションを保持して圧縮";

/** A running session or live tmux pane, reduced to what target-matching needs. */
export interface ResolvableSession {
  /** tmux session name to send keys to (e.g. `claude-<threadId12>`). */
  tmuxSession: string;
  /** The session's cwd (worktree path) to match against the token target. */
  projectDir: string;
}

export interface SessionResolveDeps {
  /** Running sessions from the DB, pre-mapped to tmux name + cwd. */
  runningSessions: () => ResolvableSession[];
  /** Live tmux panes (name + cwd) on the supervisor socket — the fallback walk. */
  listTmuxPanes: () => Promise<{ sessionName: string; cwd: string }[]>;
  /** Path normaliser (symlink-resolved absolute) for robust cwd comparison. */
  realpath: (p: string) => string;
}

/**
 * Resolve a target worktree path to a tmux session name (spec §6 order):
 *   1. the supervisor DB's running sessions (project_dir === target), then
 *   2. a live tmux pane whose cwd === target (covers sessions not in the DB,
 *      e.g. claudeHubExit or a manually-started pane).
 * Paths are compared symlink-resolved so a trailing slash / symlinked worktree
 * still matches. Returns null when nothing matches — the caller surfaces an
 * explicit "target not found" (never a silent success).
 */
export async function resolveTmuxSessionForTarget(
  target: string,
  deps: SessionResolveDeps
): Promise<string | null> {
  const targetReal = deps.realpath(target);

  for (const s of deps.runningSessions()) {
    if (deps.realpath(s.projectDir) === targetReal) {
      return s.tmuxSession;
    }
  }

  let panes: { sessionName: string; cwd: string }[];
  try {
    panes = await deps.listTmuxPanes();
  } catch (err) {
    // A tmux failure (no server / timeout) leaves only the DB path, which
    // already missed — treat as unresolved and let the caller report it.
    console.warn(
      "[action-execute] tmux pane walk failed during target resolution:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
  for (const p of panes) {
    if (deps.realpath(p.cwd) === targetReal) {
      return p.sessionName;
    }
  }
  return null;
}

export type ExecuteResult =
  | { ok: true; tmuxSession: string; sentText: string }
  | {
      ok: false;
      reason: "disallowed_action" | "target_not_found" | "send_failed";
      detail?: string;
    };

export interface ExecuteDeps {
  /** Resolve a target to a tmux session name, or null when none matches. */
  resolveSession: (target: string) => Promise<string | null>;
  /** Send the keystrokes to the pane (production: relay.ts `sendToPane`). */
  send: (tmuxSession: string, text: string) => Promise<void>;
}

/**
 * Execute an allow-listed action against its target. `compact` resolves the
 * target worktree to a tmux session and sends `/compact <intent>` via the shared
 * send sequence. Any non-allowlisted action returns `disallowed_action` rather
 * than executing (defence-in-depth). A send failure is returned as
 * `send_failed` with the cause — never swallowed.
 */
export async function executeAction(
  action: string,
  target: string,
  deps: ExecuteDeps
): Promise<ExecuteResult> {
  switch (action) {
    case "compact": {
      const tmuxSession = await deps.resolveSession(target);
      if (!tmuxSession) {
        return { ok: false, reason: "target_not_found" };
      }
      const text = `/compact ${ONE_TAP_COMPACT_INTENT}`;
      try {
        await deps.send(tmuxSession, text);
      } catch (err) {
        return {
          ok: false,
          reason: "send_failed",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      return { ok: true, tmuxSession, sentText: text };
    }
    default:
      // Unreachable when the receiver enforces the allowlist first, but kept as
      // the structural guarantee that only known actions ever run (spec §8).
      return { ok: false, reason: "disallowed_action" };
  }
}

/**
 * Production tmux pane walk: enumerate every pane on the supervisor's dedicated
 * `-L claude-hub` socket with its cwd, tab-separated so paths containing spaces
 * survive. Uses the async execFile (no shell) so a wedged tmux server cannot
 * block the event loop and a path cannot inject metacharacters.
 */
export async function realTmuxPaneList(): Promise<
  { sessionName: string; cwd: string }[]
> {
  const { stdout } = await execFileAsync(
    TMUX_PATH,
    [...TMUX_ARGS, "list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"],
    { timeout: 3000 }
  );
  const out: { sessionName: string; cwd: string }[] = [];
  for (const rawLine of stdout.toString().split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    out.push({ sessionName: line.slice(0, tab), cwd: line.slice(tab + 1) });
  }
  return out;
}

/**
 * Normalise a path for cwd comparison: symlink-resolved absolute, falling back
 * to a plain resolve when the path cannot be realpath'd (e.g. it no longer
 * exists). Mirrors worktree.ts's comparison normalisation.
 */
export function realpathOrResolve(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}
