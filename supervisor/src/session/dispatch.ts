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
 *   /dispatch <branch> <issueNumber> [selector]
 *       e.g.  /dispatch corp-dispatch-42 42            (omitted → /impl)
 *             /dispatch corp-dispatch-341 341 pdca     (Epic → /pdca)
 *             /dispatch corp-dispatch-243 243 article  (dept playbook → /article)
 *
 * claude-hub then starts a session in that channel's mapped repo on `<branch>`
 * and injects `/<command> <issueNumber>` as the session's first prompt. The
 * optional 3rd token is a *goal selector* (corp #52 M2): `no-template` (or
 * omitted / legacy `impl`) → `/impl` (one raw Issue), `pdca` → the Epic-aware
 * agent-base `/pdca` walk, and any other playbook name (`article`, `devcycle`,
 * …) → the same-named slash command (`/<selector>`). The feature is
 * intentionally generic — it hardcodes no corp-specific or dept-specific
 * playbook names; corp's typed `DispatchSelector` is the source of valid
 * tokens, and any source enumerated in the access policy (`dispatchFrom` /
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
 * Slash command (without the leading `/`) injected as the dispatched session's
 * first prompt. Derived from the dispatch *selector* (3rd token):
 *   - omitted / `impl` / `no-template` → `impl`  (one raw Issue)
 *   - `pdca`                            → `pdca`  (Epic-aware agent-base walk)
 *   - any playbook name (`article`, `devcycle`, …) → itself (`/<name> <N>`)
 * Always a validated slug ({@link SELECTOR_SLUG}, no shell metacharacters) so
 * `/<command> <issueNumber>` is safe to inject. Generic by design — no
 * dept-specific playbook names are hardcoded; corp's typed `DispatchSelector`
 * is the source of valid tokens.
 */
export type DispatchCommand = string;

/**
 * Accepted selector-token charset: a lowercase slug (`article`, `no-template`,
 * `pdca`, …). The fail-closed guard — anything with shell metacharacters,
 * uppercase, leading digit/dash or empty is rejected before it can become the
 * injected `/<command>` (defence-in-depth alongside the RW-045 branch guard).
 */
const SELECTOR_SLUG = /^[a-z][a-z0-9-]*$/;

/**
 * Map a (slug-validated) dispatch selector token to the slash command to inject.
 * `no-template` (and legacy `impl` / the omitted default) run the raw
 * single-Issue flow; every other selector becomes the same-named slash command
 * (`pdca` → `pdca`, `article` → `article`, …).
 */
function selectorToCommand(selector: string): DispatchCommand {
  return selector === "no-template" || selector === "impl" ? "impl" : selector;
}

export type ParsedDispatch =
  | { kind: "ok"; branch: string; issueNumber: number; command: DispatchCommand }
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
 * Parse a `/dispatch <branch> <issueNumber> [selector]` message. Returns:
 *   - `not_dispatch` when the content is not a `/dispatch` command (caller
 *     falls through to the normal relay path),
 *   - `error` with a coarse, identifier-free reason for a malformed command,
 *   - `ok` with a validated branch, positive-integer issue number and the
 *     injectable `command` derived from the optional selector (defaults to
 *     `impl` when omitted; see {@link selectorToCommand}).
 *
 * Selector validation is fail-closed: a present 3rd token must match
 * {@link SELECTOR_SLUG}, so a malformed token never reaches the injected
 * command. Branch validation reuses {@link resolveWorktreePath} (RW-045) so
 * metachar / traversal rejection cannot drift from the worktree path logic.
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

  // Shape: `<branch> <issueNumber>` (selector defaults to no-template=impl) or
  //        `<branch> <issueNumber> <selector>`.
  if (parts.length !== 2 && parts.length !== 3) {
    return {
      kind: "error",
      reason: "形式が不正です。/dispatch <branch> <issueNumber> [selector] で指定してください。",
    };
  }

  const [branch, issueArg, selectorArg] = parts as [string, string, string?];

  // Selector: optional 3rd token. Omitted → impl (backward compatible). A present
  // token must be a lowercase slug (fail-closed: metachars / uppercase / empty
  // are rejected so a malformed token never reaches the injected `/<command>`).
  // Known tokens map via selectorToCommand; any other slug is treated as a
  // playbook name (`/<name> <N>`) — generic, no dept names hardcoded here.
  let command: DispatchCommand = "impl";
  if (selectorArg !== undefined) {
    if (!SELECTOR_SLUG.test(selectorArg)) {
      return {
        kind: "error",
        reason:
          "selector が不正です（英小文字スラッグのみ。例 impl / pdca / article / devcycle / no-template）。",
      };
    }
    command = selectorToCommand(selectorArg);
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
   * dead pane. {@link runDispatch} injects the slash command (`/<command>`, e.g.
   * `/impl`, `/pdca`, `/article`) only after this so the slash-picker doesn't
   * swallow the leading `/` while the
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
  command: DispatchCommand;
  sessionManager: DispatchSessionManager;
  createThread: DispatchThreadFactory;
}

export type RunDispatchResult =
  | { ok: true; threadId: string; injected: string }
  | { ok: false; stage: "thread" | "start" | "inject"; error: string };

/**
 * Orchestrate a validated dispatch: create the thread, start the session in the
 * channel's repo on `branch`, then inject `/<command> <issueNumber>` as the
 * first prompt (`command` is the selector-derived slug, e.g. `impl` / `pdca` /
 * `article`). `start()` does not accept an
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
