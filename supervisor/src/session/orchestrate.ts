/**
 * Message-driven orchestrator startup (Epic #316 Phase 1 / Issue #318).
 *
 * `/orchestrate <生引数...>` は corp チャンネルから複数タスク（handoff `.tmp`
 * パス / `repo#issue` / 自然言語の混在可）を一括で受け付け、オーケストレーター
 * 専用の Claude Code セッション（tmux + corp スレッド）を 1 本起動して、引数を
 * そのまま初期プロンプトとして注入する。
 *
 * ADR-002 (docs/adr/2026-07-05-corp-orchestration.md) D2 の責務境界に従い、
 * Supervisor 側の実装は「受付・認可・多重起動ガード・セッション起動・引数注入」
 * のみに留める（thin-scaffolding）。監視ループ・依存管理・merge 判断はすべて
 * オーケストレータースキル（Phase 2 #319 の `/orchestrate-runner`）の責務。
 *
 * dispatch.ts と同型の構成: パース（純関数）とオーケストレーション（注入可能な
 * seam）を分離し、Discord gateway / 実 SessionManager なしでユニットテスト可能
 * に保つ。認可は dispatch の `dispatchFrom` とは独立で、通常メッセージと同じ
 * `evaluateAccess`（access.json の `allowFrom`、fail-closed）を bot.ts 側で通す。
 *
 * 引数の安全性: Supervisor は引数を一切解釈しない（解釈はスキル側の責務）。
 * 注入は既存 relay の argv-no-shell 経路（`SessionManager.sendMessage` →
 * tmux `send-keys -l`、シェル展開なし）のみを通るため、shell メタ文字を含む
 * 生引数でもコマンドインジェクション面は生じない。
 */

/** Literal trigger token. `/orchestrated` 等の前方一致誤爆は parser 側で防ぐ。 */
export const ORCHESTRATE_PREFIX = "/orchestrate";

/**
 * オーケストレーターセッションの branch prefix。多重起動ガード
 * ({@link findRunningOrchestrator}) は running セッションの branch がこの
 * prefix で始まるかで「オーケストレーターかどうか」を判定する。
 */
export const ORCHESTRATE_BRANCH_PREFIX = "orchestrate-";

/**
 * 起動直後に注入するスキルコマンド名（Phase 2 #319 のスキル名との
 * インターフェース契約 — 変更するときは Epic #316 の全 Phase と同期すること）。
 * 常に固定リテラルで、生引数は後ろに付くのみ。
 */
export const ORCHESTRATE_RUNNER_COMMAND = "/orchestrate-runner";

/**
 * 多重起動ガードを明示的に迂回するフラグ。先頭トークンとしてのみ解釈する
 * （`/orchestrate --new <引数...>`）。それ以外の位置の `--new` は生引数の一部
 * としてそのままオーケストレーターへ渡る（Supervisor は引数を解釈しない原則）。
 */
export const ORCHESTRATE_NEW_FLAG = "--new";

export type ParsedOrchestrate =
  | { kind: "ok"; rawArgs: string; forceNew: boolean }
  | { kind: "not_orchestrate" }
  | { kind: "error"; reason: string };

/**
 * Parse a `/orchestrate <生引数...>` message. Returns:
 *   - `not_orchestrate` when the content is not an `/orchestrate` command
 *     (caller falls through to the normal relay / dispatch path),
 *   - `error` when the command has no arguments (there is nothing to run),
 *   - `ok` with the raw argument string preserved verbatim (inner whitespace
 *     included) and the `--new` leading-flag extracted.
 *
 * dispatch と違い引数の形状検証は行わない — `.tmp` パス / `repo#issue` /
 * 自然言語の解釈はオーケストレータースキルの責務（ADR-002 D2）。
 */
export function parseOrchestrateCommand(content: string): ParsedOrchestrate {
  const trimmed = content.trim();

  // Match the exact `/orchestrate` token (not `/orchestrated`, not
  // `/orchestrate-runner`). The command must be the whole leading token
  // followed by whitespace or EOL.
  if (
    trimmed !== ORCHESTRATE_PREFIX &&
    !trimmed.startsWith(ORCHESTRATE_PREFIX + " ") &&
    !trimmed.startsWith(ORCHESTRATE_PREFIX + "\n")
  ) {
    return { kind: "not_orchestrate" };
  }

  let rest = trimmed.slice(ORCHESTRATE_PREFIX.length).trim();

  // `--new` は先頭トークンのみフラグとして解釈し、残りを生引数とする。
  let forceNew = false;
  if (rest === ORCHESTRATE_NEW_FLAG) {
    forceNew = true;
    rest = "";
  } else if (rest.startsWith(ORCHESTRATE_NEW_FLAG + " ")) {
    forceNew = true;
    rest = rest.slice(ORCHESTRATE_NEW_FLAG.length).trim();
  }

  if (rest.length === 0) {
    return {
      kind: "error",
      reason:
        "引数が空です。/orchestrate <タスク...>（.tmp パス / repo#issue / 自然言語、複数可）で指定してください。",
    };
  }

  return { kind: "ok", rawArgs: rest, forceNew };
}

/**
 * Minimal running-session surface the duplicate-launch guard needs (structural
 * subset of SessionInfo so tests can pass plain objects).
 */
export interface OrchestratorSessionLike {
  threadId: string;
  branch?: string;
}

/**
 * Duplicate-launch guard: return the first running orchestrator session
 * (branch prefixed {@link ORCHESTRATE_BRANCH_PREFIX}) in the given channel's
 * running-session list, or undefined when none. The caller (bot.ts) answers
 * with a thread link instead of starting a second orchestrator, unless the
 * user explicitly passed `--new`.
 */
export function findRunningOrchestrator(
  sessions: readonly OrchestratorSessionLike[],
): OrchestratorSessionLike | undefined {
  return sessions.find((s) =>
    (s.branch ?? "").startsWith(ORCHESTRATE_BRANCH_PREFIX),
  );
}

/**
 * Generate the orchestrator worktree branch name: `orchestrate-<yyyymmdd-hhmm>`
 * (Issue #318 の作業項目で指定された形式、ローカル時刻)。数字とハイフンのみで
 * 構成されるため RW-045 の worktree guard（メタ文字 / traversal 拒否）を常に
 * 通過する。同一分内の再起動は多重起動ガード（または `--new` 時の worktree
 * 追加失敗）で表面化する — silent fallback はしない。
 */
export function orchestrateBranchName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  return `${ORCHESTRATE_BRANCH_PREFIX}${y}${m}${d}-${hh}${mm}`;
}

/**
 * Minimal SessionManager surface the orchestrate flow needs. Keeping it
 * structural lets tests inject a fake without the real tmux/claude stack
 * (dispatch.ts の DispatchSessionManager と同パターン)。
 */
export interface OrchestrateSessionManager {
  start(config: unknown, threadId: string, branch?: string): Promise<unknown>;
  /**
   * Wait until the freshly started session's Ink TUI is ready to accept
   * input. {@link runOrchestrate} injects `/orchestrate-runner <生引数>` only
   * after this so the slash-picker doesn't swallow the leading `/` while the
   * TUI is still booting (RW-025 / RW-047 timing class).
   */
  waitForInputReady(threadId: string): Promise<boolean>;
  sendMessage(threadId: string, message: string): Promise<unknown>;
}

/** Creates the Discord thread the orchestrator runs in and returns its id. */
export type OrchestrateThreadFactory = (
  branch: string,
) => Promise<{ id: string }>;

export interface RunOrchestrateArgs {
  config: unknown;
  branch: string;
  /** 生引数（パースしない）。`/orchestrate-runner ` の後ろにそのまま付く。 */
  rawArgs: string;
  sessionManager: OrchestrateSessionManager;
  createThread: OrchestrateThreadFactory;
}

export type RunOrchestrateResult =
  | { ok: true; threadId: string; injected: string }
  | { ok: false; stage: "thread" | "start" | "inject"; error: string };

/**
 * Orchestrate a validated `/orchestrate`: create the thread, start the session
 * in the channel's repo on the `orchestrate-<yyyymmdd-hhmm>` branch, then
 * inject `/orchestrate-runner <生引数>` as the first prompt. `start()` does not
 * accept an initial command (it only launches the pane), so the command is
 * injected via `sendMessage` after the session is registered — the same
 * argv-no-shell path a user's first thread message would take.
 *
 * Errors are surfaced (no silent fallback): a failure is tagged with the stage
 * so the caller can log it without leaking the raw payload.
 */
export async function runOrchestrate(
  args: RunOrchestrateArgs,
): Promise<RunOrchestrateResult> {
  const { config, branch, rawArgs, sessionManager, createThread } = args;

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

  // The TUI is still booting when start() returns — start() only waits for the
  // PID, not an input-ready prompt (dispatch.ts と同じ RW-025 / RW-047 対策)。
  // Best-effort: on timeout / probe error we still inject (the marker may have
  // scrolled off and the TUI is ready by then) so a transient miss never drops
  // the orchestrate silently.
  try {
    const ready = await sessionManager.waitForInputReady(threadId);
    if (!ready) {
      console.warn(
        `[Orchestrate] input-ready marker not seen for thread ${threadId}; injecting anyway`,
      );
    }
  } catch (err) {
    console.warn(
      `[Orchestrate] waitForInputReady failed for thread ${threadId}: ${errMsg(err)}`,
    );
  }

  const initialCommand = `${ORCHESTRATE_RUNNER_COMMAND} ${rawArgs}`;
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
