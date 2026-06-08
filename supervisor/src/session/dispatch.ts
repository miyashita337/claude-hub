/**
 * Message-driven dispatch transport (Issue #32 / S7, claude-hub side of the
 * external "S3 executor" trigger).
 *
 * Session startup is otherwise reachable only via the `/session start` slash
 * command (an InteractionCreate). A webhook / bot cannot send slash commands
 * and `MessageCreate` drops every `message.author.bot`, so there is no way for
 * an external system (e.g. a corp dispatcher) to start a session by message.
 *
 * This module adds a generic transport: an *allowed source* posts a single
 * message to a known department channel:
 *
 *   /dispatch <branch> <issueNumber> [impl|pdca]
 *       e.g.  /dispatch corp-dispatch-42 42          (defaults to /impl)
 *             /dispatch corp-dispatch-341 341 pdca   (Epic → /pdca)
 *
 * claude-hub then starts a session in that channel's mapped repo on `<branch>`
 * and injects `/<command> <issueNumber>` as the session's first prompt. The
 * optional 3rd token selects `impl` (default — a single Issue) or `pdca`
 * (Epic-aware: the agent-base `/pdca` flow walks the Epic's child Issues). The
 * feature is intentionally generic — it hardcodes no corp-specific names; any
 * source enumerated in the access policy (`dispatchFrom` /
 * `DISPATCH_ALLOWED_SOURCE_IDS`) can drive it.
 *
 * Authorization (who may dispatch) lives in `config/access-policy.ts`
 * (`isDispatchSourceAllowed`, fail-closed). This module owns parsing and the
 * (injectable) orchestration so both are unit-testable without a Discord
 * gateway or a real SessionManager.
 */

import { resolveWorktreePath } from "./worktree";

/** Literal trigger token. Exposed so external callers (corp) can match it. */
export const DISPATCH_PREFIX = "/dispatch";

/**
 * Slash command the dispatched session runs first. `impl` = one Issue (default);
 * `pdca` = the Epic-aware agent-base `/pdca` flow that walks child Issues.
 */
export type DispatchMode = "impl" | "pdca";

export type ParsedDispatch =
  | { kind: "ok"; branch: string; issueNumber: number; command: DispatchMode }
  | { kind: "not_dispatch" }
  | { kind: "error"; reason: string };

/**
 * Sentinel root used only to validate a branch name through the RW-045
 * worktree guard (`resolveWorktreePath` rejects shell metacharacters, path
 * traversal and empty/`.` names). The resolved path is discarded — the real
 * worktree path is computed later against the channel's repo dir.
 */
const BRANCH_VALIDATION_ROOT = "/__dispatch_branch_validation__";

/**
 * Parse a `/dispatch <branch> <issueNumber> [impl|pdca]` message. Returns:
 *   - `not_dispatch` when the content is not a `/dispatch` command (caller
 *     falls through to the normal relay path),
 *   - `error` with a coarse, identifier-free reason for a malformed command,
 *   - `ok` with a validated branch, positive-integer issue number and command
 *     mode (defaults to `impl` when the optional 3rd token is omitted).
 *
 * Branch validation reuses {@link resolveWorktreePath} (RW-045) so metachar /
 * traversal rejection cannot drift from the worktree path logic.
 */
export function parseDispatchCommand(content: string): ParsedDispatch {
  const trimmed = content.trim();

  // Match the exact `/dispatch` token (not `/dispatcher`, not `/impl`). The
  // command must be the whole leading token followed by whitespace or EOL.
  if (trimmed !== DISPATCH_PREFIX && !trimmed.startsWith(DISPATCH_PREFIX + " ")) {
    return { kind: "not_dispatch" };
  }

  const rest = trimmed.slice(DISPATCH_PREFIX.length).trim();
  const parts = rest.length > 0 ? rest.split(/\s+/) : [];

  // Shape: `<branch> <issueNumber>` (mode defaults to impl) or
  //        `<branch> <issueNumber> <impl|pdca>`.
  if (parts.length !== 2 && parts.length !== 3) {
    return {
      kind: "error",
      reason: "形式が不正です。/dispatch <branch> <issueNumber> [impl|pdca] で指定してください。",
    };
  }

  const [branch, issueArg, modeArg] = parts as [string, string, string?];

  // Mode: optional 3rd token, default impl (backward compatible). Fail-closed on
  // any unrecognized command so a typo never silently runs the wrong flow.
  let command: DispatchMode = "impl";
  if (modeArg !== undefined) {
    if (modeArg !== "impl" && modeArg !== "pdca") {
      return {
        kind: "error",
        reason: "mode は impl または pdca を指定してください。",
      };
    }
    command = modeArg;
  }

  // Issue number: positive integer only (no decimals, signs, or trailing text).
  if (!/^[0-9]+$/.test(issueArg)) {
    return {
      kind: "error",
      reason: "issueNumber は正の整数で指定してください。",
    };
  }
  const issueNumber = Number(issueArg);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return {
      kind: "error",
      reason: "issueNumber は正の整数で指定してください。",
    };
  }

  // Branch: reuse the worktree guard (RW-045) for metachar / traversal / empty.
  try {
    resolveWorktreePath(BRANCH_VALIDATION_ROOT, branch);
  } catch {
    return {
      kind: "error",
      reason: "branch 名が不正です（使用できない文字または path traversal）。",
    };
  }

  return { kind: "ok", branch, issueNumber, command };
}

/**
 * Minimal SessionManager surface the dispatch orchestrator needs. Keeping it
 * structural lets tests inject a fake without the real tmux/claude stack.
 */
export interface DispatchSessionManager {
  start(
    config: unknown,
    threadId: string,
    branch?: string,
  ): Promise<unknown>;
  /**
   * Wait until the freshly started session's Ink TUI is ready to accept input.
   * Resolves true when the input-ready marker is observed, false on timeout or a
   * dead pane. {@link runDispatch} injects the slash command (`/impl` or `/pdca`)
   * only after this so the slash-picker doesn't swallow the leading `/` while the
   * TUI is still booting (RW-025 / RW-047 timing class).
   */
  waitForInputReady(threadId: string): Promise<boolean>;
  sendMessage(threadId: string, message: string): Promise<unknown>;
}

/** Creates the Discord thread the session runs in and returns its id. */
export type DispatchThreadFactory = (
  branch: string,
) => Promise<{ id: string }>;

export interface RunDispatchArgs {
  config: unknown;
  branch: string;
  issueNumber: number;
  command: DispatchMode;
  sessionManager: DispatchSessionManager;
  createThread: DispatchThreadFactory;
}

export type RunDispatchResult =
  | { ok: true; threadId: string; injected: string }
  | { ok: false; stage: "thread" | "start" | "inject"; error: string };

/**
 * Orchestrate a validated dispatch: create the thread, start the session in the
 * channel's repo on `branch`, then inject `/<command> <issueNumber>` as the
 * first prompt (`command` is `impl` or `pdca`). `start()` does not accept an
 * initial command (it only launches the pane), so the command is injected via
 * `sendMessage` after the session is registered — the same path a user's first
 * thread message would take.
 *
 * Errors are surfaced (no silent fallback): a failure is tagged with the stage
 * so the caller can log it without leaking the raw payload.
 */
export async function runDispatch(
  args: RunDispatchArgs,
): Promise<RunDispatchResult> {
  const { config, branch, issueNumber, command, sessionManager, createThread } =
    args;

  let threadId: string;
  try {
    const thread = await createThread(branch);
    threadId = thread.id;
  } catch (err) {
    return { ok: false, stage: "thread", error: errMsg(err) };
  }

  try {
    await sessionManager.start(config, threadId, branch);
  } catch (err) {
    return { ok: false, stage: "start", error: errMsg(err) };
  }

  // The dept TUI is still booting when start() returns — start() only waits for
  // the PID, not an input-ready prompt. Injecting the slash command into a
  // not-yet-ready Ink TUI lets the slash-command picker swallow the leading `/` and strands
  // the text un-submitted (RW-025 / RW-047 timing class — observed live as
  // "impl <N>" stuck in the input box). Wait for the input-ready marker first.
  // Best-effort: on timeout / probe error we still inject (the marker may have
  // scrolled off and the TUI is ready by then) so a transient miss never drops
  // the dispatch silently.
  try {
    const ready = await sessionManager.waitForInputReady(threadId);
    if (!ready) {
      console.warn(
        `[Dispatch] input-ready marker not seen for thread ${threadId}; injecting anyway`,
      );
    }
  } catch (err) {
    console.warn(
      `[Dispatch] waitForInputReady failed for thread ${threadId}: ${errMsg(err)}`,
    );
  }

  const initialCommand = `/${command} ${issueNumber}`;
  try {
    await sessionManager.sendMessage(threadId, initialCommand);
  } catch (err) {
    return { ok: false, stage: "inject", error: errMsg(err) };
  }

  return { ok: true, threadId, injected: initialCommand };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
