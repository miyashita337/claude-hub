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
 * optional 3rd token is a *goal selector* (corp #52 M2) from a closed set:
 * `no-template` (or omitted / legacy `impl`) → `/impl` (one raw Issue), `pdca` →
 * the Epic-aware agent-base `/pdca` walk, and `article` / `devcycle` → the dept
 * goal playbooks (`/article`, `/devcycle`). The selector set is fail-closed
 * (unknown tokens are rejected, not guessed) and mirrors corp's typed
 * `DispatchSelector`. *Who* may dispatch stays generic — it hardcodes no
 * corp-specific source; any source enumerated in the access policy
 * (`dispatchFrom` / `DISPATCH_ALLOWED_SOURCE_IDS`) can drive it.
 *
 * Authorization (who may dispatch) lives in `config/access-policy.ts`
 * (`isDispatchSourceAllowed`, fail-closed). This module owns parsing and the
 * (injectable) orchestration so both are unit-testable without a Discord
 * gateway or a real SessionManager.
 */

import { resolveWorktreePath } from "./worktree";
import { formatForDiscord } from "./output-formatter";
import {
  buildDialogStuckHandler,
  type DialogStuckInfo,
} from "./dialog-stuck-handler";

/** Literal trigger token. Exposed so external callers (corp) can match it. */
export const DISPATCH_PREFIX = "/dispatch";

/**
 * Dispatch executor backend (Epic #285 Phase 2). `"tmux"` is the current
 * interactive-TUI path (start → waitForInputReady → sendMessage); `"headless"`
 * runs `claude -p` and returns captured stdout. Opt-in and fail-safe: anything
 * other than the exact literal `"headless"` resolves to `"tmux"`, so the default
 * (env unset) is unchanged (AC-4).
 */
export type DispatchExecutorMode = "tmux" | "headless";

/**
 * Resolve the executor mode from the environment (Epic #285 / #287). Read at the
 * bot boundary and passed explicitly into {@link runDispatch} so the orchestrator
 * stays pure/testable. Only the exact string `"headless"` enables headless.
 */
export function resolveExecutorMode(
  env: Record<string, string | undefined> = process.env,
): DispatchExecutorMode {
  return env.DISPATCH_EXECUTOR_MODE === "headless" ? "headless" : "tmux";
}

/**
 * Dispatch goal selector — the optional 3rd token of
 * `/dispatch <branch> <N> <selector>` (corp #52 M2 / #261). A **closed** set:
 * the parser is fail-closed, so any token outside this union is rejected rather
 * than guessed (a typo never silently runs the wrong flow). Mirrors corp's typed
 * `DispatchSelector`; legacy `impl` is kept for the pre-M2 wire format.
 *   - `no-template` (or legacy `impl`, or omitted) → the raw single-Issue flow
 *   - `pdca`                                        → the Epic-aware /pdca walk
 *   - `article` / `devcycle`                        → the dept goal playbooks
 */
export type DispatchSelector =
  | "impl"
  | "no-template"
  | "pdca"
  | "article"
  | "devcycle";

const DISPATCH_SELECTORS: readonly DispatchSelector[] = [
  "impl",
  "no-template",
  "pdca",
  "article",
  "devcycle",
];

/**
 * Slash command (without the leading `/`) injected as the session's first
 * prompt. `no-template` / legacy `impl` collapse to `impl`; the others are the
 * same-named command. Always a fixed literal (never user text) so
 * `/<command> <issueNumber>` is safe to inject.
 */
export type DispatchCommand = "impl" | "pdca" | "article" | "devcycle";

/** Map a validated selector to the slash command to inject. */
function selectorToCommand(selector: DispatchSelector): DispatchCommand {
  return selector === "no-template" ? "impl" : selector;
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

  // Selector: optional 3rd token, default impl (backward compatible). Fail-closed
  // on any token outside the closed DispatchSelector set so a typo never silently
  // runs the wrong flow, then map it to the slash command to inject.
  let command: DispatchCommand = "impl";
  if (selectorArg !== undefined) {
    if (!(DISPATCH_SELECTORS as readonly string[]).includes(selectorArg)) {
      return {
        kind: "error",
        reason:
          "selector は impl / no-template / pdca / article / devcycle のいずれかを指定してください。",
      };
    }
    command = selectorToCommand(selectorArg as DispatchSelector);
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
 * Captured result of a headless dispatch run (Epic #285 Phase 2). Structurally a
 * subset of the manager's HeadlessSessionResult, so a SessionManager satisfies
 * this seam without importing the concrete type.
 */
export interface DispatchHeadlessOutcome {
  /** Child exit code, or null when killed (e.g. timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * Completion verdict from the manager's post-exit probe (Issue #342).
   * `pending`/`unknown` runs are surfaced as warnings in the thread even on
   * exit 0 — the two observed silent failures both exited 0. Optional so a
   * minimal fake (or an older manager) still satisfies the seam; absent means
   * "no probe ran" and no completion warning is posted.
   */
  completion?: { status: "clean" | "pending" | "unknown"; detail: string };
  /**
   * Artifact verdict from the manager's post-exit probe (Issue #342, Layer 2
   * extension). `none`/`unknown` runs are surfaced as warnings even on exit 0
   * + clean completion — a run that finished cleanly but delivered no commit /
   * PR / Issue / comment is the remaining silent-failure shape. Optional for
   * the same seam-compatibility reason as `completion`.
   */
  artifacts?: { status: "found" | "none" | "unknown"; detail: string; dirty: boolean };
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
  /**
   * `options.onDialogStuck` is forwarded to the relay's dialog watchdog. Passing
   * it is not optional in practice for dispatch (PR #431 review, should-4): a
   * dispatch session has no human watching its pane, so a dialog the watchdog
   * refuses to auto-accept — which since #423 includes every AskUserQuestion —
   * would otherwise stall with the news going no further than console.warn.
   */
  sendMessage(
    threadId: string,
    message: string,
    attachments?: unknown[],
    options?: {
      onDialogStuck?: (info: DialogStuckInfo) => void | Promise<void>;
    },
  ): Promise<unknown>;
  /**
   * Headless executor path (Epic #285 Phase 2 / #287). Runs `claude -p
   * "<initialCommand>"` in the branch worktree to completion and resolves with
   * the captured output. Optional so a tmux-only fake still satisfies the
   * interface; {@link runDispatch} verifies it is present before taking the
   * headless branch (no silent fallback).
   *
   * `issueNumber` (Epic #75 Phase 4 / #289) is the target Issue the run posts
   * its "Dispatch 実行レポート" comment to on completion; it is threaded through
   * so the manager can post from the worktree cwd before teardown.
   */
  runHeadless?(
    config: unknown,
    threadId: string,
    initialCommand: string,
    branch?: string,
    issueNumber?: number,
  ): Promise<DispatchHeadlessOutcome>;
}

/**
 * Post a single (already Discord-safe) message to the dispatch thread. Injected
 * so the headless path can stream its formatted output back without runDispatch
 * importing discord.js. Each `content` is <= Discord's 2000-char limit (the
 * caller chunks via {@link formatForDiscord}).
 */
export type DispatchThreadPoster = (
  threadId: string,
  content: string,
) => Promise<void>;

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
  /**
   * Executor backend (Epic #285 Phase 2). Defaults to `"tmux"` (current
   * behaviour). `"headless"` requires `sessionManager.runHeadless` and
   * {@link postToThread} to be present. Injected explicitly (bot.ts derives it
   * from `DISPATCH_EXECUTOR_MODE` via {@link resolveExecutorMode}) so the
   * orchestrator stays pure.
   */
  executorMode?: DispatchExecutorMode;
  /**
   * Posts the headless run's formatted output back to the dispatch thread.
   * Required for the headless path; unused by the tmux path (bot.ts posts its
   * own welcome there).
   */
  postToThread?: DispatchThreadPoster;
}

export type RunDispatchResult =
  | {
      ok: true;
      /** `"tmux"` (default, unchanged) or `"headless"` (Epic #285 Phase 2). */
      mode: "tmux" | "headless";
      threadId: string;
      injected: string;
      /** Headless only: child exit code (null when killed / timed out). */
      exitCode?: number | null;
      /** Headless only: true when the run hit the executor timeout. */
      timedOut?: boolean;
    }
  | {
      ok: false;
      stage: "thread" | "start" | "inject" | "output";
      error: string;
    };

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

  // Epic #285 Phase 2: opt-in headless path. Default (env unset → "tmux") keeps
  // the interactive-TUI flow below entirely unchanged (AC-4).
  if ((args.executorMode ?? "tmux") === "headless") {
    return runDispatchHeadless(args);
  }

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

  // PR #431 review (should-4). The remaining silent-stall path after #423: when
  // POST /ask fails outright (connection refused, or 503 because no subscriber
  // is registered) the hook falls back immediately, so no ask is ever pending
  // and the expiry notice never fires — nothing tells the thread. The dialog
  // watchdog does see it, but only reports through `onDialogStuck`, which this
  // path has never supplied. The thread already exists and `postToThread`
  // already writes to it, so the heartbeat costs one adapter.
  const poster = args.postToThread;
  if (!poster) {
    console.warn(
      `[Dispatch] no postToThread for thread ${threadId}; a dialog needing a human will only reach the log`,
    );
  }
  const onDialogStuck = poster
    ? buildDialogStuckHandler({ send: (content) => poster(threadId, content) })
    : undefined;

  const initialCommand = `/${command} ${issueNumber}`;
  try {
    await sessionManager.sendMessage(
      threadId,
      initialCommand,
      undefined,
      onDialogStuck ? { onDialogStuck } : undefined,
    );
  } catch (err) {
    return { ok: false, stage: "inject", error: errMsg(err) };
  }

  return { ok: true, mode: "tmux", threadId, injected: initialCommand };
}

/**
 * Headless dispatch orchestration (Epic #285 Phase 2 / #287). Creates the
 * thread, posts a start notice, runs `claude -p "<initialCommand>"` to
 * completion, then posts the formatted stdout back to the thread. Every terminal
 * state posts SOMETHING — non-zero exit, timeout, and empty-but-successful
 * output are all surfaced explicitly (AC-5 / agent-output-quality #1: no silent
 * success, no silent fallback).
 *
 * `ok` reports whether the DISPATCH was orchestrated (thread made, run executed,
 * output posted) — a failed *job* (non-zero exit) is still `ok:true` because its
 * failure was delivered to the thread; `exitCode` / `timedOut` carry the job
 * outcome for the caller to log. `ok:false` is reserved for orchestration
 * failures (thread creation, spawn, posting, or missing headless wiring).
 */
async function runDispatchHeadless(
  args: RunDispatchArgs,
): Promise<RunDispatchResult> {
  const { config, branch, issueNumber, command, sessionManager, createThread } =
    args;
  const postToThread = args.postToThread;
  const initialCommand = `/${command} ${issueNumber}`;

  // Fail-closed: headless requires both the manager capability and a poster. A
  // missing wire is a config error, surfaced (not silently downgraded to tmux).
  if (!sessionManager.runHeadless || !postToThread) {
    return {
      ok: false,
      stage: "start",
      error:
        "headless executor is not wired (sessionManager.runHeadless / postToThread missing)",
    };
  }

  let threadId: string;
  try {
    const thread = await createThread(branch);
    threadId = thread.id;
  } catch (err) {
    return { ok: false, stage: "thread", error: errMsg(err) };
  }

  // Start notice (best-effort: a failed notice must not abort the actual run).
  try {
    await postToThread(
      threadId,
      `🤖 headless 実行を開始します: \`${initialCommand}\`（ブランチ \`${branch}\`）`,
    );
  } catch (err) {
    console.warn(
      `[Dispatch] headless start notice failed for thread ${threadId}: ${errMsg(err)}`,
    );
  }

  let outcome: DispatchHeadlessOutcome;
  try {
    outcome = await sessionManager.runHeadless(
      config,
      threadId,
      initialCommand,
      branch,
      issueNumber,
    );
  } catch (err) {
    // Spawn / worktree failure — surface to the thread AND the caller.
    const error = errMsg(err);
    try {
      await postToThread(
        threadId,
        `❌ headless 実行を開始できませんでした: ${error}`,
      );
    } catch (postErr) {
      console.warn(
        `[Dispatch] failed to post headless start-error for thread ${threadId}: ${errMsg(postErr)}`,
      );
    }
    return { ok: false, stage: "start", error };
  }

  const posted = await postHeadlessOutcome(
    threadId,
    initialCommand,
    outcome,
    postToThread,
  );
  if (!posted.ok) {
    return { ok: false, stage: "output", error: posted.error };
  }

  return {
    ok: true,
    mode: "headless",
    threadId,
    injected: initialCommand,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
  };
}

/** How many trailing chars of stderr to echo on failure (keep the thread lean). */
const STDERR_TAIL_LEN = 1500;

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > STDERR_TAIL_LEN
    ? `…${trimmed.slice(-STDERR_TAIL_LEN)}`
    : trimmed;
}

/**
 * Render a headless outcome into Discord-safe chunks and post them (Epic #285
 * Phase 2 / #287, AC-2 / AC-5). Distinguishes four terminal states, none of
 * which is silent:
 *   - timeout       → ⏱️ notice + any partial stdout + stderr tail
 *   - non-zero exit → ❌ notice (with exit code) + stdout + stderr tail
 *   - exit 0, empty → ⚠️ explicit "succeeded but produced no output"
 *   - exit 0, text  → the formatted stdout
 * Returns `{ ok:false, error }` only when posting itself throws.
 */
async function postHeadlessOutcome(
  threadId: string,
  initialCommand: string,
  outcome: DispatchHeadlessOutcome,
  postToThread: DispatchThreadPoster,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const chunks: string[] = [];
  const stdout = outcome.stdout.trim();
  const stderr = stderrTail(outcome.stderr);

  if (outcome.timedOut) {
    chunks.push(
      `⏱️ headless 実行がタイムアウトしました（\`${initialCommand}\`）。以下は打ち切り時点の出力です:`,
    );
    if (stdout) chunks.push(...formatForDiscord(outcome.stdout));
    else chunks.push("（stdout は空でした）");
    if (stderr) chunks.push(...formatForDiscord(`stderr:\n${stderr}`));
  } else if (outcome.exitCode !== 0) {
    chunks.push(
      `❌ headless 実行が非ゼロ終了しました（exit ${outcome.exitCode}, \`${initialCommand}\`）:`,
    );
    if (stdout) chunks.push(...formatForDiscord(outcome.stdout));
    if (stderr) chunks.push(...formatForDiscord(`stderr:\n${stderr}`));
    if (!stdout && !stderr) chunks.push("（stdout / stderr ともに空でした）");
  } else if (!stdout) {
    // exit 0 but nothing on stdout — never present this as success (#1).
    chunks.push(
      `⚠️ headless 実行は正常終了 (exit 0) しましたが stdout が空でした（\`${initialCommand}\`）。ジョブが本当に完了したかログを確認してください。`,
    );
  } else {
    chunks.push(...formatForDiscord(outcome.stdout));
  }

  // Issue #342: a pending/unknown completion is a warning REGARDLESS of the
  // exit code — both observed silent failures exited 0 with work in flight.
  const completion = outcome.completion;
  if (completion && completion.status !== "clean") {
    chunks.push(
      `⚠️ この run は正常完了と確認できていません（completion: ${completion.status}）。` +
        `${completion.detail ? `\n検出内容: ${completion.detail}` : ""}\n` +
        `worktree は復旧用に保全されています。同じブランチへの再 dispatch で作業状態を引き継げます（Issue claude-hub#342）。`,
    );
  }

  // Issue #342 Layer 2 extension: zero artifacts is a warning REGARDLESS of
  // exit code or completion — "finished cleanly but delivered nothing" is the
  // remaining silent-failure shape the pending probe cannot see.
  const artifacts = outcome.artifacts;
  if (artifacts && artifacts.status !== "found") {
    chunks.push(
      `⚠️ この run の成果物（commit / PR / Issue / コメント）を確認できませんでした（artifacts: ${artifacts.status}）。` +
        `${artifacts.detail ? `\n検出内容: ${artifacts.detail}` : ""}` +
        `${artifacts.dirty ? "\n未 commit の変更が worktree に残っているため、worktree を復旧用に保全しています。" : ""}` +
        `\n作業が実際に行われたか確認してください（Issue claude-hub#342）。`,
    );
  }

  try {
    for (const chunk of chunks) {
      await postToThread(threadId, chunk);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
