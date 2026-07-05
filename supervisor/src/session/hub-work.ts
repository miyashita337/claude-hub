/**
 * claude-hub work セッション経路 (Epic #316 Phase 3 / #320, ADR-002 D5 = #208 案B).
 *
 * claude-hub は Supervisor 自身のリポジトリであり、CHANNEL_MAP へ登録すると
 * Supervisor クラッシュ時の Discord 復旧経路（claudeHubExit / hijoguchi）が
 * メタ依存で失われる。そのため `channels.ts:141-147` の FATAL guard が登録を
 * 起動時 throw で禁止している（絶対ルール、docs/bot-operations.md）。
 *
 * 本モジュールはその絶対ルールを保ったまま claude-hub タスクを dispatch 可能に
 * する「work セッション経路」を実装する（ADR-002 D5）:
 *
 *   1. CHANNEL_MAP には一切触れない。config は `CHANNEL_MAP.get()` を通さず
 *      本モジュールが組み立てる ephemeral な {@link ChannelConfig} を
 *      SessionManager に明示渡しする。**この config を CHANNEL_MAP へ登録する
 *      ことは禁止**（ADR-002 D5-2。{@link buildHubWorkConfig} の contract）。
 *   2. ワーカースレッドは corp チャンネル配下に立てる（D5-3、専用チャンネル案
 *      は却下済み）。スレッド作成は caller（bot.ts）が corp チャンネルを解決
 *      して行い、本モジュールは Discord に依存しない。
 *   3. work セッションは使い捨ての worktree セッションであり claude-hub の
 *      復旧経路ではない（D5 非干渉条件 2）。hijoguchi の access policy /
 *      機械ゲートには一切触れない（非干渉条件 3）。
 *
 * 起動・selector 注入・welcome・FIFO キューは既存 /dispatch と同一機構
 * （{@link runDispatch} / DispatchQueue）を再利用する（Epic #316 決定 4:
 * 新規ワーカー機構は作らない）。トリガーは Discord メッセージではなく
 * relay サーバの `POST /hub-work`（loopback-only）で、ローカルの
 * オーケストレーター CC セッションが `session-ctl start-hub-worker` から叩く。
 */

import { resolve } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import type { ChannelConfig } from "../config/channels";
import { MAX_SESSIONS } from "../config/channels";
import {
  DISPATCH_PREFIX,
  parseDispatchCommand,
  runDispatch,
  type DispatchCommand,
  type DispatchExecutorMode,
  type DispatchSessionManager,
  type DispatchThreadPoster,
} from "./dispatch";
import type { QueuedDispatch } from "./dispatch-queue";
import { buildThreadTitle } from "./thread-title";

/**
 * sessions.db の `channel_name` に記録される work セッションのラベル。
 * Discord チャンネル名ではない（work スレッドの親は corp チャンネル）。
 * CHANNEL_MAP のどのキーとも一致しないこと、そして `"claude-hub"` そのもの
 * ではないこと（FATAL guard の検査対象文字列）がテストで固定される。
 */
export const HUB_WORK_CHANNEL_NAME = "claude-hub-work";

/** work ワーカースレッドを立てる親チャンネル（ADR-002 D5-3: corp 採用）。 */
export const HUB_WORK_PARENT_CHANNEL = "corp";

export const HUB_WORK_DISPLAY_NAME = "Claude Hub Work";

/**
 * work セッション用の ephemeral な ChannelConfig を組み立てる（ADR-002 D5-2）。
 *
 * CONTRACT: この config を CHANNEL_MAP に登録してはならない。登録した瞬間に
 * FATAL guard の意図（復旧経路のメタ依存禁止）が形骸化する。SessionManager /
 * runDispatch へ**引数として明示渡し**する用途に限る。
 *
 * mcpProfile / chromeEnabled は既定（"none" / false）のまま = dispatch
 * セッションと同じ軽量プロファイルで起動する。
 */
export function buildHubWorkConfig(home: string = homedir()): ChannelConfig {
  return {
    channelName: HUB_WORK_CHANNEL_NAME,
    dir: resolve(home, "claude-hub"),
    displayName: HUB_WORK_DISPLAY_NAME,
  };
}

export type ParsedHubWork =
  | {
      kind: "ok";
      branch: string;
      issueNumber: number;
      command: DispatchCommand;
    }
  | { kind: "error"; reason: string };

/**
 * `POST /hub-work` の JSON body（`{branch, issueNumber, selector?}`）を検証する。
 *
 * 検証本体は既存 `/dispatch` のパーサ（{@link parseDispatchCommand}）へ委譲する
 * ことで single source of truth を保つ: branch の RW-045 guard（メタ文字 /
 * path traversal 拒否）と selector の閉集合 fail-closed 検証は dispatch と
 * バイト単位で同一になる。委譲前に「1 トークンとして安全に文字列合成できる形か」
 * （空白を含まない等）だけをここで確認する。
 */
export function parseHubWorkRequest(body: unknown): ParsedHubWork {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      kind: "error",
      reason:
        "リクエスト body は {branch, issueNumber, selector?} の JSON オブジェクトで指定してください。",
    };
  }
  const { branch, issueNumber, selector } = body as Record<string, unknown>;

  if (typeof branch !== "string" || branch.length === 0 || /\s/.test(branch)) {
    return {
      kind: "error",
      reason: "branch は空白を含まない非空文字列で指定してください。",
    };
  }
  if (
    typeof issueNumber !== "number" ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return {
      kind: "error",
      reason: "issueNumber は正の整数で指定してください。",
    };
  }
  if (selector !== undefined) {
    if (typeof selector !== "string" || selector.length === 0 || /\s/.test(selector)) {
      return {
        kind: "error",
        reason:
          "selector は impl / no-template / pdca / article / devcycle のいずれかを指定してください。",
      };
    }
  }

  // ここまでで各フィールドは 1 トークンであることが保証されているので、
  // `/dispatch <branch> <N> [selector]` の message 形に合成して既存パーサへ
  // 委譲できる（トークン境界が崩れない）。
  const message =
    `${DISPATCH_PREFIX} ${branch} ${issueNumber}` +
    (selector !== undefined ? ` ${selector}` : "");
  const parsed = parseDispatchCommand(message);
  if (parsed.kind === "ok") {
    return {
      kind: "ok",
      branch: parsed.branch,
      issueNumber: parsed.issueNumber,
      command: parsed.command,
    };
  }
  if (parsed.kind === "error") {
    return { kind: "error", reason: parsed.reason };
  }
  // "not_dispatch" は合成 message が DISPATCH_PREFIX で始まる以上起こり得ない
  // が、fail-closed に倒す（黙って通さない）。
  return { kind: "error", reason: "リクエスト形式が不正です。" };
}

/** runHubWork が使うキューの最小面（DispatchQueue が構造的に満たす）。 */
export interface HubWorkQueue {
  limit(): number;
  submit(item: QueuedDispatch): Promise<"started" | "queued">;
}

/** runHubWork が使う SessionManager の最小面（実 SessionManager が構造的に満たす）。 */
export interface HubWorkSessionManager extends DispatchSessionManager {
  listRunningByChannel(channelName: string): Array<{ branch?: string }>;
  count(): number;
}

export interface RunHubWorkArgs {
  /** `POST /hub-work` の JSON body（未検証）。 */
  body: unknown;
  sessionManager: HubWorkSessionManager;
  queue: HubWorkQueue;
  /**
   * corp チャンネル配下にワーカースレッドを作る（ADR-002 D5-3）。caller
   * （bot.ts）が corp チャンネルの解決と Discord API 呼び出しを担う。throw は
   * 500 として caller へ返る。
   */
  createThread: (threadName: string) => Promise<{ id: string }>;
  /** スレッドへ 1 メッセージ投稿（Discord 2000 字制限は caller/formatter 側で担保）。 */
  postToThread: DispatchThreadPoster;
  /** 省略時は {@link buildHubWorkConfig}()。テストで差し替え可能。 */
  config?: ChannelConfig;
  /** 省略時 "tmux"（既存 dispatch と同じ既定）。 */
  executorMode?: DispatchExecutorMode;
  /** Phase 5d admission ゲート（既存 dispatch と同じ WARN-first）。省略時 no-op。 */
  admissionGate?: () => Promise<void>;
  /** テスト差し替え用。省略時 fs.existsSync。 */
  dirExists?: (dir: string) => boolean;
}

export type RunHubWorkResult =
  | { ok: true; threadId: string; queued: boolean; injected: string }
  | { ok: false; status: number; error: string };

/**
 * hub work dispatch を 1 件オーケストレーションする:
 * body 検証（fail-closed）→ corp スレッド作成 → 既存 DispatchQueue へ submit
 * → スロット獲得後に {@link runDispatch}（ephemeral config 明示渡し）。
 *
 * 既存 `/dispatch`（bot.ts handleDispatchMessage）と同じ「スレッド先行作成 →
 * queue.submit(key=threadId)」順序を踏襲するので、FIFO / 上限 /
 * notifyEnded によるスロット解放のセマンティクスは既存とまったく同じになる
 * （ADR-002 D4: 独自の並列制御を持たない）。
 */
export async function runHubWork(args: RunHubWorkArgs): Promise<RunHubWorkResult> {
  const parsed = parseHubWorkRequest(args.body);
  if (parsed.kind === "error") {
    return { ok: false, status: 400, error: parsed.reason };
  }
  const { branch, issueNumber, command } = parsed;

  const config = args.config ?? buildHubWorkConfig();
  const dirExists = args.dirExists ?? existsSync;
  if (!dirExists(config.dir)) {
    return {
      ok: false,
      status: 500,
      error: `claude-hub リポジトリが見つかりません: ${config.dir}`,
    };
  }

  const { sessionManager, queue, postToThread } = args;

  // スレッド名は既存 dispatch と同じ規約（同 branch 並走のシーケンス付き、
  // RW-046 の同 branch 多重セッション識別）。
  let thread: { id: string };
  try {
    const sameBranchCount = sessionManager
      .listRunningByChannel(config.channelName)
      .filter((s) => s.branch === branch).length;
    const threadName = buildThreadTitle(
      "running",
      branch,
      config.displayName,
      sameBranchCount + 1,
    );
    thread = await args.createThread(threadName);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `ワーカースレッドを作成できませんでした: ${errMsg(err)}`,
    };
  }

  const injected = `/${command} ${issueNumber}`;

  // スロット獲得後に実行される本体。戻り値はセッションが実際に起動したか
  // （DispatchQueue のスロット保持契約。失敗時 false で即時解放）。
  const runOnce = async (): Promise<boolean> => {
    await args.admissionGate?.();
    const result = await runDispatch({
      config,
      branch,
      issueNumber,
      command,
      sessionManager,
      executorMode: args.executorMode ?? "tmux",
      postToThread,
      createThread: async () => thread, // 先行作成済みスレッドを再利用
    });

    if (result.ok && result.mode === "tmux") {
      try {
        await postToThread(
          result.threadId,
          `🛰️ **${config.displayName}** を work セッション経路で起動しました（ADR-002 D5 / #320）\n\n` +
            `🌿 ブランチ: \`${branch}\`\n` +
            `▶️ 初期コマンド: \`${result.injected}\`\n` +
            `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}`,
        );
      } catch (err) {
        console.error(
          `[HubWork] welcome message failed for thread ${result.threadId}:`,
          errMsg(err),
        );
      }
    } else if (result.ok) {
      console.log(
        `[HubWork] headless hub work completed (thread=${result.threadId}, exit=${result.exitCode}, timedOut=${result.timedOut})`,
      );
    } else {
      console.error(
        `[HubWork] hub work dispatch failed (stage=${result.stage}): ${result.error}`,
      );
      // 起動失敗をスレッドにも明示する（サイレント失敗にしない）。
      try {
        await postToThread(
          thread.id,
          `❌ work セッションの起動に失敗しました（stage=${result.stage}）: ${result.error}`,
        );
      } catch (postErr) {
        console.error(
          `[HubWork] failed to post start-error to thread ${thread.id}:`,
          errMsg(postErr),
        );
      }
    }
    return result.ok;
  };

  const submitted = await queue.submit({
    key: thread.id,
    run: runOnce,
    onQueued: async (position) => {
      await postToThread(
        thread.id,
        `⏳ 同時実行の上限（${queue.limit()}）に達しているため待機中です（キュー ${position} 番目）。` +
          `先行 dispatch の完了後、FIFO で自動起動します。`,
      );
    },
    onDequeued: async () => {
      await postToThread(thread.id, `▶️ 空きが出たため、キューから起動します。`);
    },
  });

  return {
    ok: true,
    threadId: thread.id,
    queued: submitted === "queued",
    injected,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
