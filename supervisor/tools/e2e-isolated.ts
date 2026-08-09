#!/usr/bin/env bun
/**
 * e2e-isolated — 隔離スタックで走らせる決定的 E2E シナリオ群
 * (Issue #386 / Epic #381)。
 *
 * 実 Supervisor（稼働中の本番プロセス）では実行できない検証を、
 * **mock claude + 専用 tmux socket + 専用 sessions.db + 専用 runtime dir** の
 * 使い捨てスタックで再現する。e2e-live.ts が子プロセスとして起動する。
 *
 *   - **s2-4** error loop: ワーカーが同じエラーを 3 回返す →
 *     検知 → `session-ctl stop` → 報告文生成（{@link runErrorLoopScenario}）
 *   - **s2-5** worktree 再利用: ワーカーを kill → 同じ branch で再入 →
 *     **同一 worktree が再利用され未コミットの作業が残る**
 *     （{@link runWorktreeReuseScenario}）
 *
 * ## 何を検証し、何を検証しないか
 *
 * agent-base `rules/general/orchestration-escalation-policy.md` B-3 は
 * 「error loop（エラー署名が 3 回一致）→ 当該ワーカーを `session-ctl stop`
 * → スレッド報告 → 別アプローチでの自動再投入はしない（L2 申し送り）」、および
 * 「dead-session 再入（hub）は `start-hub-worker` 再実行で自動再起動（同 branch は
 * worktree 再利用で冪等）」と定める。
 *
 *   - **検証する**: 実ワーカーの実出力に対する「同一署名 3 回」判定、
 *     `session-ctl stop` が実際にループ中のワーカーを落とすこと、
 *     停止が sessions.db と tmux の双方に反映されること、報告文の生成、
 *     kill 後の再入で実 git worktree が再利用され作業が残ること。
 *   - **検証しない**: 「このエラーは同じ失敗か」というオーケストレーター
 *     （モデル）の意味判断。ここは実走（#322）の観測範囲のまま残す。
 *     `POST /hub-work` 経由の投入そのものは e2e-live の S1b / S2-5 live レグが見る。
 *
 * この切り分けにより、実モデル・実課金なしで S2-4 / S2-5 の**機構**を回帰にできる。
 * ワーカーの claude は {@link ../tests/e2e/fixtures/claude-error-loop-mock.sh}
 * （毎回同一のエラー中核 + 可変タイムスタンプ）や既存の `claude-mock.sh`
 * （エコー応答）に差し替える。
 *
 * ## なぜ e2e-live.ts の中で直接動かさず、別プロセスなのか
 *
 * Supervisor の 3 つのグローバルが **モジュールロード時に固定**されるため:
 *
 *   - `TMUX_SOCKET`（tmux.ts）— 既定 `claude-hub` = 本番 socket（RW-019）
 *   - `DB_PATH`（infra/db.ts）— 既定 `~/claude-hub/supervisor/sessions.db`
 *   - relay ポートファイル（relay-server.ts）— `XDG_RUNTIME_DIR` 由来。
 *     SessionManager のコンストラクタが relay サーバを start するので、
 *     隔離しないと**稼働中 Supervisor のポートファイルを上書き**し、
 *     session-ctl の discovery を壊す
 *
 * よって呼び出し側（e2e-live.ts）が隔離 env を与えて子プロセスとして起動する。
 * 隔離が欠けたまま起動された場合は {@link assertIsolatedEnv} が fail-closed で
 * 落とす（本番資産を壊すくらいならシナリオを落とす）。
 *
 * ## 使い方（通常は e2e-live.ts が spawn する。単体デバッグ用）
 *
 *   SUPERVISOR_TMUX_SOCKET=claude-hub-e2e-el \
 *   SUPERVISOR_DB_PATH=/tmp/e2e-el/sessions.db \
 *   XDG_RUNTIME_DIR=/tmp/e2e-el/runtime \
 *   SUPERVISOR_CLAUDE_PATH=supervisor/tests/e2e/fixtures/claude-error-loop-mock.sh \
 *   bun supervisor/tools/e2e-isolated.ts --scenario s2-4
 *
 * 結果は最終行に `E2E_ISOLATED_RESULT: <json>` として出す（親が parse する）。
 *
 * 本モジュールの **静的 import は純関数のみ**に限る。SessionManager 等の
 * 重い import は {@link runErrorLoopScenario} 内の動的 import に置く:
 * そうしないと隔離チェックより先に db.ts / tmux.ts が評価され、ガードが
 * 用をなさない（ESM の import は巻き上げられる）。単体テストが純関数だけを
 * 安全に import できる、という副次効果もある。
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// 純関数（隔離不要 = 単体テスト可能）
// ---------------------------------------------------------------------------

/** error loop と判定するまでの同一署名の反復回数（policy B-3「3 回一致」）。 */
export const ERROR_LOOP_THRESHOLD = 3;

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ISO_TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
/** 8 桁以上の 16 進列（UUID 断片 / オブジェクト ID / ハッシュ）。 */
const HEX_ID = /\b[0-9a-f]{8,}\b/gi;
const DIGIT_RUN = /\d+/g;

/**
 * エラーテキストを「同じ失敗かどうか」の比較キーへ正規化する。
 *
 * 実 CLI のエラーは毎回タイムスタンプ・PID・試行回数・一時ファイル名が変わる。
 * それらを落とさずに文字列一致を取ると、同じ失敗を 3 回踏んでも永遠に
 * error loop と判定できない（＝ policy B-3 が発火しない）。落としすぎると
 * 別の失敗まで同一視するので、可変部として**時刻・16 進 ID・数値**のみを潰す。
 */
export function errorSignature(text: string): string {
  return text
    .replace(ANSI_ESCAPE, "")
    .replace(ISO_TIMESTAMP, "<ts>")
    .replace(HEX_ID, "<id>")
    .replace(DIGIT_RUN, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * テキストがエラー報告に見えるか。
 *
 * 「同一署名 3 回」を無条件に適用すると、同じ成功応答を 3 回返しただけの
 * ワーカーまで error loop として停止してしまう（誤 kill）。停止は不可逆に
 * 近い介入なので、エラーらしさを前段の条件に置く（デフォルトの安全性）。
 */
export function looksLikeError(text: string): boolean {
  return /error|エラー|failed|failure|失敗|exception|traceback|panic|fatal/i.test(
    text,
  );
}

export interface ErrorLoopVerdict {
  detected: boolean;
  /** 最多で反復した署名（エラー候補が 0 件なら null）。 */
  signature: string | null;
  /** その署名の反復回数。 */
  count: number;
  threshold: number;
  /** 判定対象になった（= エラーに見えた）テキスト数。 */
  considered: number;
}

/**
 * policy B-3 の error loop 判定: エラーに見えるテキストのうち、同一署名が
 * `threshold` 回以上現れたら detected。
 */
export function detectErrorLoop(
  texts: readonly string[],
  threshold: number = ERROR_LOOP_THRESHOLD,
): ErrorLoopVerdict {
  const errors = texts.filter(looksLikeError);
  const counts = new Map<string, number>();
  for (const text of errors) {
    const sig = errorSignature(text);
    if (!sig) continue;
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  let signature: string | null = null;
  let count = 0;
  for (const [sig, n] of counts) {
    if (n > count) {
      signature = sig;
      count = n;
    }
  }
  return {
    detected: count >= threshold,
    signature,
    count,
    threshold,
    considered: errors.length,
  };
}

export interface ErrorLoopReportInput {
  /** ワーカーの識別子（session id / branch / thread など、読み手が辿れるもの）。 */
  worker: string;
  verdict: ErrorLoopVerdict;
  /** 最後に観測した生のエラーテキスト（署名ではなく現物）。 */
  lastError: string;
  /** `session-ctl stop` の結果（exit code や理由）。 */
  stopOutcome: string;
}

/**
 * スレッドへ投稿する error loop 報告を組み立てる。
 *
 * policy B-3 は「当該ワーカーを stop → スレッド報告 → **他ワーカーは継続** /
 * 別アプローチでの自動再投入はしない（L2 申し送り）」と定める。報告文には
 * 「なぜ止めたか（署名と回数）」と「自動再投入しない」ことを必ず含める:
 * これが無いと読み手は放置（silent）と区別できない。
 */
export function formatErrorLoopReport(input: ErrorLoopReportInput): string {
  const { worker, verdict, lastError, stopOutcome } = input;
  return [
    "🛑 error loop 検知のためワーカーを停止しました（S2-4 / policy B-3）",
    `- worker: ${worker}`,
    `- 同一エラー: ${verdict.count} 回（閾値 ${verdict.threshold}）`,
    `- 署名: ${verdict.signature ?? "(なし)"}`,
    `- 直近のエラー: ${lastError.trim()}`,
    `- 停止結果: ${stopOutcome}`,
    "- 別アプローチでの自動再投入はしません（L2 申し送り）",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 隔離ガード
// ---------------------------------------------------------------------------

/** 本番 Supervisor が使う tmux socket（RW-019）。ここへ相乗りしてはならない。 */
export const PRODUCTION_TMUX_SOCKET = "claude-hub";

/**
 * relay ポートファイルのパス（relay-server.ts `relayPortFilePath` と同一規則）。
 *
 * 規則をここに複製しているのは、ガードが **relay-server.ts を import する前**に
 * 走る必要があるため（import した時点で本番 socket / DB の解決が起きる）。
 * relay-server.ts 側を変更したら本関数も追随すること。
 */
function relayPortFileFor(env: Record<string, string | undefined>): string {
  const runtimeDir = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "claude-hub-supervisor")
    : `/tmp/claude-hub-supervisor-${env.USER || "default"}`;
  return join(runtimeDir, "relay-port");
}

/**
 * 隔離 env が揃っているかを検査し、欠けていれば throw する（fail-closed）。
 *
 * 稼働中 Supervisor の tmux セッション・sessions.db・relay ポートファイルを
 * 壊しうる状態では、シナリオを走らせるより落とす方が安全。
 */
export function assertIsolatedEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const problems: string[] = [];

  const socket = env.SUPERVISOR_TMUX_SOCKET ?? "";
  if (!socket) {
    problems.push("SUPERVISOR_TMUX_SOCKET が未設定（本番 socket に相乗りします）");
  } else if (socket === PRODUCTION_TMUX_SOCKET) {
    problems.push(
      `SUPERVISOR_TMUX_SOCKET=${socket} は本番 socket（RW-019）。別名を指定してください`,
    );
  }

  const dbPath = env.SUPERVISOR_DB_PATH ?? "";
  const prodDbPath = resolve(homedir(), "claude-hub", "supervisor", "sessions.db");
  if (!dbPath) {
    problems.push("SUPERVISOR_DB_PATH が未設定（本番 sessions.db に書き込みます）");
  } else if (resolve(dbPath) === prodDbPath) {
    problems.push(`SUPERVISOR_DB_PATH=${dbPath} は本番 DB。別パスを指定してください`);
  } else if (dbPath === ":memory:") {
    // SessionManager（書き込み）と session-ctl（読み取り）は別コネクションで開くため、
    // :memory: では行が共有されず stop の検証が成立しない。
    problems.push(
      "SUPERVISOR_DB_PATH=:memory: は不可（書き手と読み手で別 DB になるため）。一時ファイルを指定してください",
    );
  }

  if (!env.XDG_RUNTIME_DIR) {
    problems.push(
      "XDG_RUNTIME_DIR が未設定（稼働中 Supervisor の relay-port ファイルを上書きします）",
    );
  } else {
    const portFile = relayPortFileFor(env);
    if (existsSync(portFile)) {
      problems.push(
        `既存の relay-port ファイルを上書きします: ${portFile}（未使用の一時ディレクトリを指定してください）`,
      );
    }
  }

  const claudePath = env.SUPERVISOR_CLAUDE_PATH ?? "";
  if (!claudePath) {
    problems.push(
      "SUPERVISOR_CLAUDE_PATH が未設定（実 claude が起動し課金されます）",
    );
  } else if (!existsSync(claudePath)) {
    problems.push(`SUPERVISOR_CLAUDE_PATH が存在しません: ${claudePath}`);
  }

  if (problems.length > 0) {
    throw new Error(
      "e2e-error-loop: 隔離 env が不十分なため中断しました。\n" +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// シナリオ本体（隔離 env 前提）
// ---------------------------------------------------------------------------

export interface ErrorLoopScenarioResult {
  /** 全レグ（検知 / 停止）が期待どおりだったか。 */
  ok: boolean;
  /** ワーカーから観測した応答（3 回分）。 */
  replies: string[];
  verdict: ErrorLoopVerdict;
  /** `session-ctl stop` の exit code（未実行なら null）。 */
  stopExit: number | null;
  /** stop 後の sessions.db の status（未取得なら null）。 */
  dbStatus: string | null;
  /** stop 後に tmux セッションが消えたか。 */
  tmuxGone: boolean;
  tmuxName: string;
  /** スレッドへ投稿すべき報告文。 */
  report: string;
  /** 満たせなかった条件（空なら ok=true）。silent に落とさないための記録。 */
  failures: string[];
}

const PROMPT_COUNT = ERROR_LOOP_THRESHOLD;

/**
 * error loop シナリオを一通り走らせる。
 *
 * 1. 隔離スタック（mock claude + 専用 tmux socket + 専用 sessions.db）で
 *    ワーカーを 1 本起動する
 * 2. 3 回プロンプトを送り、実 relay 経由で返る応答を集める
 * 3. {@link detectErrorLoop} で policy B-3 の判定を行う
 * 4. 検知したら **実 `session-ctl stop`** で停止し、tmux 消滅と DB 反映を確認する
 * 5. 報告文を組み立てて返す（Discord への配達は呼び出し側の責務）
 */
export async function runErrorLoopScenario(): Promise<ErrorLoopScenarioResult> {
  assertIsolatedEnv();

  // 動的 import: 上のガードを通過してから db.ts / tmux.ts を評価する（冒頭の
  // docblock 参照）。
  const { SessionManager } = await import("../src/session/manager");
  const { FakeItermAdapter } = await import("../src/session/adapters-fake");
  const { TMUX_PATH, TMUX_ARGS } = await import("../src/session/tmux");
  const { runSessionCtl, createRealEffects } = await import("./session-ctl");
  const { Database } = await import("bun:sqlite");
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");

  const execFileAsync = promisify(execFile);
  const failures: string[] = [];
  const replies: string[] = [];

  const workDir = mkdtempSync(join(tmpdir(), "e2e-error-loop-"));
  const projectDir = join(workDir, "project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# e2e error loop fixture\n");

  // FakeItermAdapter: 実 iTerm2 タブを開かせない（開発機で窓が増えるのを防ぐ）。
  // tmux / relay / DB は実物を使う = 検証したい経路はそのまま。
  const manager = new SessionManager({
    effects: { iterm2: new FakeItermAdapter() },
  });
  const config = {
    channelName: "e2e-error-loop",
    dir: projectDir,
    displayName: "E2E Error Loop",
  };
  const threadId = `e2e-error-loop-${process.pid}-${Date.now()}`;
  const tmuxName = SessionManager.tmuxSessionNameFor(threadId);

  const hasTmuxSession = async (name: string): Promise<boolean> => {
    try {
      await execFileAsync(TMUX_PATH, [...TMUX_ARGS, "has-session", "-t", name], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  };

  let stopExit: number | null = null;
  let dbStatus: string | null = null;
  let tmuxGone = false;
  let verdict: ErrorLoopVerdict = {
    detected: false,
    signature: null,
    count: 0,
    threshold: ERROR_LOOP_THRESHOLD,
    considered: 0,
  };
  let report = "";

  try {
    await manager.start(config, threadId);

    for (let i = 1; i <= PROMPT_COUNT; i++) {
      const result = await manager.sendMessage(
        threadId,
        `e2e error loop probe #${i}`,
      );
      // relay が返す本文（text）を第一とし、無ければ chunks を連結する。
      // 空応答は「エラーが返らなかった」という観測結果としてそのまま残す
      // （空文字を捏造して埋めない）。
      const text = result.text ?? result.chunks.join("\n");
      if (result.error) {
        failures.push(`プロンプト #${i} の relay がエラー: ${result.error}`);
      }
      replies.push(text);
    }

    verdict = detectErrorLoop(replies);
    if (!verdict.detected) {
      failures.push(
        `error loop 未検知: 同一署名 ${verdict.count} 回 (閾値 ${verdict.threshold}, 判定対象 ${verdict.considered} 件)`,
      );
    }

    // 停止は SessionManager.stop ではなく **実 session-ctl stop** を通す。
    // policy B-3 が指定する介入経路そのものを検証したいため。
    const db = new Database(process.env.SUPERVISOR_DB_PATH!, { readonly: true });
    let rowId: string | null = null;
    try {
      const row = db
        .prepare(`SELECT id FROM sessions WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1`)
        .get(threadId) as { id: string } | undefined;
      rowId = row?.id ?? null;
    } finally {
      db.close();
    }

    if (!rowId) {
      failures.push("sessions.db にワーカー行が見つからない（stop を検証できない）");
    } else {
      stopExit = await runSessionCtl(["stop", rowId], createRealEffects(), {
        statusWaitMs: 45_000,
      });
      if (stopExit !== 0) failures.push(`session-ctl stop が exit ${stopExit}`);

      const db2 = new Database(process.env.SUPERVISOR_DB_PATH!, { readonly: true });
      try {
        const row = db2
          .prepare(`SELECT status FROM sessions WHERE id = ?`)
          .get(rowId) as { status: string } | undefined;
        dbStatus = row?.status ?? null;
      } finally {
        db2.close();
      }
      if (dbStatus === "running") {
        failures.push("stop 後も sessions.db が status=running のまま");
      }
    }

    tmuxGone = !(await hasTmuxSession(tmuxName));
    if (!tmuxGone) failures.push(`stop 後も tmux セッション ${tmuxName} が生存`);

    report = formatErrorLoopReport({
      worker: `${rowId ?? threadId} (tmux ${tmuxName})`,
      verdict,
      lastError: replies[replies.length - 1] ?? "(応答なし)",
      stopOutcome: `session-ctl stop exit=${stopExit ?? "-"} / sessions.db status=${dbStatus ?? "-"}`,
    });
  } catch (err) {
    failures.push(
      `シナリオが例外で中断: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  } finally {
    // 後始末は best-effort だが黙って捨てない（agent-output-quality #1）。
    try {
      await manager.shutdownAll();
    } catch (err) {
      console.warn(`[e2e-isolated] shutdownAll failed: ${err}`);
    }
    try {
      // 隔離 socket のみを kill する（本番 socket には触れない）。
      await execFileAsync(TMUX_PATH, [...TMUX_ARGS, "kill-server"], {
        timeout: 10_000,
      });
    } catch {
      // サーバ未起動 / 既に停止済み。
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[e2e-isolated] workDir cleanup failed: ${err}`);
    }
  }

  return {
    ok: failures.length === 0,
    replies,
    verdict,
    stopExit,
    dbStatus,
    tmuxGone,
    tmuxName,
    report,
    failures,
  };
}

// ---------------------------------------------------------------------------
// S2-5: kill → 同 branch 再入で worktree 再利用
// ---------------------------------------------------------------------------

export interface WorktreeReuseScenarioResult {
  ok: boolean;
  /** 初回セッションの worktree（sessions.db の project_dir）。 */
  worktreeBefore: string | null;
  /** 再入セッションの worktree。 */
  worktreeAfter: string | null;
  sameWorktree: boolean;
  /** kill が Supervisor 側（watcher）に検知され status が running から外れたか。 */
  deadDetected: boolean;
  /** kill を挟んでも worktree 内の未コミット作業（sentinel）が残っていたか。 */
  workSurvived: boolean;
  /** 再入セッションが応答を返したか（= 再び使える状態に戻ったか）。 */
  responsive: boolean;
  /** 再入セッションの応答（デバッグ用）。 */
  reply: string;
  failures: string[];
}

/**
 * worktree 再利用シナリオを走らせる。
 *
 * 1. 一時 git リポジトリを作り、branch を切って worktree セッションを起動する
 * 2. worktree に**未コミットの作業**（sentinel ファイル）を置く
 * 3. tmux セッションを kill して「ワーカーの突然死」を作る
 * 4. Supervisor 相当（SessionManager の watcher）が dead を検知し、
 *    **worktree を壊さない**こと（RW-046）を確認する
 * 5. 同じ branch で再入し、**同一 worktree が再利用され sentinel が残っている**
 *    こと、セッションが応答可能に戻ることを確認する
 *
 * path の同一性だけでなく sentinel の生存を見るのは、worktree を作り直しても
 * path は一致してしまい「作業が失われた」ことを検出できないため。
 */
export async function runWorktreeReuseScenario(): Promise<WorktreeReuseScenarioResult> {
  assertIsolatedEnv();

  const { SessionManager } = await import("../src/session/manager");
  const { FakeItermAdapter } = await import("../src/session/adapters-fake");
  const { TMUX_PATH, TMUX_ARGS } = await import("../src/session/tmux");
  const { Database } = await import("bun:sqlite");
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");

  const execFileAsync = promisify(execFile);
  const failures: string[] = [];

  const workDir = mkdtempSync(join(tmpdir(), "e2e-worktree-reuse-"));
  const repoDir = join(workDir, "repo");
  mkdirSync(repoDir, { recursive: true });

  const git = (args: string[]) =>
    execFileAsync("git", args, { cwd: repoDir, timeout: 20_000 });

  const dbPath = process.env.SUPERVISOR_DB_PATH!;
  const rowFor = (threadId: string): { id: string; status: string; project_dir: string } | null => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db
        .prepare(
          `SELECT id, status, project_dir FROM sessions WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1`,
        )
        .get(threadId) as { id: string; status: string; project_dir: string } | undefined) ?? null;
    } finally {
      db.close();
    }
  };
  const poll = async <T>(fn: () => T | null, timeoutMs: number, intervalMs = 2_000) => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v !== null) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  const manager = new SessionManager({
    effects: { iterm2: new FakeItermAdapter() },
  });
  const branch = `e2e-reuse-${process.pid}-${Date.now()}`;
  const config = {
    channelName: "e2e-worktree-reuse",
    dir: repoDir,
    displayName: "E2E Worktree Reuse",
  };
  const threadA = `e2e-reuse-a-${process.pid}-${Date.now()}`;
  const threadB = `e2e-reuse-b-${process.pid}-${Date.now()}`;

  let worktreeBefore: string | null = null;
  let worktreeAfter: string | null = null;
  let deadDetected = false;
  let workSurvived = false;
  let responsive = false;
  let reply = "";

  try {
    // 一時 git リポジトリ + ローカル branch（worktree.ensure の Q1 経路に載せる。
    // Q2 は origin へ fetch しに行くのでリモート無しの一時リポでは使えない）。
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "e2e@example.invalid"]);
    await git(["config", "user.name", "e2e"]);
    await git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repoDir, "README.md"), "# e2e worktree reuse fixture\n");
    await git(["add", "README.md"]);
    await git(["commit", "-q", "-m", "init"]);
    await git(["branch", branch]);

    // (1) 初回起動 → worktree が切られる
    await manager.start(config, threadA, branch);
    const rowA = await poll(() => {
      const r = rowFor(threadA);
      return r && r.status === "running" ? r : null;
    }, 60_000);
    if (!rowA) {
      failures.push("初回セッションの running 行が sessions.db に現れない");
      throw new Error("初回セッション起動に失敗");
    }
    worktreeBefore = rowA.project_dir;

    // (2) 未コミットの作業を置く（再利用の証拠。path 一致だけでは作り直しを検出できない）
    const sentinel = join(worktreeBefore, ".e2e-uncommitted-work");
    writeFileSync(sentinel, `e2e worktree reuse sentinel ${branch}\n`);

    // (3) kill（session-ctl stop の graceful ではなく突然死を模す）
    const tmuxA = SessionManager.tmuxSessionNameFor(threadA);
    try {
      await execFileAsync(TMUX_PATH, [...TMUX_ARGS, "kill-session", "-t", tmuxA], {
        timeout: 10_000,
      });
    } catch (err) {
      failures.push(`tmux kill-session に失敗: ${err}`);
    }

    // (4) watcher が dead を検知（10s poll なので余裕を持って待つ）
    const dead = await poll(() => {
      const r = rowFor(threadA);
      return r && r.status !== "running" ? r : null;
    }, 90_000);
    deadDetected = dead !== null;
    if (!deadDetected) failures.push("kill 後 90 秒以内に status が running から外れない");

    // (5) worktree と未コミット作業の保全（RW-046）
    workSurvived = existsSync(worktreeBefore) && existsSync(sentinel);
    if (!workSurvived) {
      failures.push(
        `kill で worktree / 未コミット作業が失われた（worktree=${existsSync(worktreeBefore)} sentinel=${existsSync(sentinel)}）`,
      );
    }

    // (6) 同じ branch で再入
    await manager.start(config, threadB, branch);
    const rowB = await poll(() => {
      const r = rowFor(threadB);
      return r && r.status === "running" ? r : null;
    }, 60_000);
    if (!rowB) {
      failures.push("再入セッションの running 行が sessions.db に現れない");
    } else {
      worktreeAfter = rowB.project_dir;
      if (worktreeAfter !== worktreeBefore) {
        failures.push(
          `再入で worktree が変わった: before=${worktreeBefore} after=${worktreeAfter}`,
        );
      }
      if (!existsSync(sentinel)) {
        failures.push("再入後に未コミット作業（sentinel）が消えている = worktree 作り直し");
        workSurvived = false;
      }

      // (7) 応答可能に戻ったか
      const result = await manager.sendMessage(threadB, "e2e worktree reuse ping");
      reply = result.text ?? result.chunks.join("\n");
      responsive = !result.error && reply.trim().length > 0;
      if (!responsive) {
        failures.push(`再入セッションが応答しない: error=${result.error ?? "-"} reply=${JSON.stringify(reply)}`);
      }
      await manager.stop(threadB, "manual");
    }
  } catch (err) {
    failures.push(
      `シナリオが例外で中断: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  } finally {
    try {
      await manager.shutdownAll();
    } catch (err) {
      console.warn(`[e2e-isolated] shutdownAll failed: ${err}`);
    }
    try {
      await execFileAsync(TMUX_PATH, [...TMUX_ARGS, "kill-server"], { timeout: 10_000 });
    } catch {
      // サーバ未起動 / 既に停止済み。
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[e2e-isolated] workDir cleanup failed: ${err}`);
    }
  }

  return {
    ok: failures.length === 0,
    worktreeBefore,
    worktreeAfter,
    sameWorktree: worktreeBefore !== null && worktreeBefore === worktreeAfter,
    deadDetected,
    workSurvived,
    responsive,
    reply,
    failures,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 親プロセスが結果を拾うための行頭マーカー。 */
export const RESULT_MARKER = "E2E_ISOLATED_RESULT:";

/** `--scenario` に指定できる id。 */
export const ISOLATED_SCENARIOS = ["s2-4", "s2-5"] as const;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--scenario");
  const scenario = i >= 0 && argv[i + 1] ? argv[i + 1]! : "";

  const emit = (result: { ok: boolean; failures: string[] }): never => {
    console.log(`${RESULT_MARKER} ${JSON.stringify(result)}`);
    process.exit(result.ok ? 0 : 1);
  };

  const run = async (): Promise<{ ok: boolean; failures: string[] }> => {
    if (scenario === "s2-4") return await runErrorLoopScenario();
    if (scenario === "s2-5") return await runWorktreeReuseScenario();
    // 未指定 / 未知は fail-closed（黙って何もせず 0 終了しない）。
    return {
      ok: false,
      failures: [
        `--scenario は ${ISOLATED_SCENARIOS.join(" / ")} のいずれかを指定してください（指定値: ${scenario || "(なし)"}）`,
      ],
    };
  };

  run()
    .then(emit)
    .catch((err) => {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(message);
      emit({ ok: false, failures: [message] });
    });
}
