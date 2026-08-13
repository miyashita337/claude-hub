/**
 * 朝レポ契機の CEO セッション起こし（#426 / corp#112 の AC-1）。
 *
 * corp が朝レポ（CEO 提案 `[D1]..[Dn]`）を #corp へ配信しても、`bot.ts` の
 * `if (message.author.bot) return;` が bot / webhook のメッセージを一律 drop する
 * ため、corp スレッドで稼働中の CEO セッションは「朝レポが来た」ことを知れない。
 * その結果「朝レポ → CEO が決裁を問う → 会長がタップ → 決裁実行」というジャーニーが
 * 起点で成立しない（#412 のボタン UI / #416 の回答待ちが揃っても、質問を発生させる
 * 主体が居ない）。
 *
 * 本モジュールはその受け口を、**既存 `/dispatch` と同じ認可・同じ入口形状**で用意する:
 *
 *   1. トリガーは既知チャンネルの**非スレッド**メッセージ `/brief <YYYY-MM-DD>`。
 *      corp の朝レポ配信 webhook ではなく、corp の **dispatch bot**（別 identity）が
 *      post する。webhook URL はそれ自体が bearer credential であり、かつ自由文の
 *      レポート本文を運ぶ経路でもあるため、権限（トリガー）と内容（本文）を別
 *      identity に分けておく。
 *   2. 認可は {@link isDispatchSourceAllowed} を**そのまま**再利用する。policy 不在 /
 *      channel 未登録 / `dispatchFrom` 未列挙 の 3 つの deny がそのまま効く
 *      （fail-closed）。新しい認可モデルを書かない = 新しい抜け道を作らない。
 *   3. **セッションへ注入する文字列は claude-hub が組み立て、自由文を一切受け取らない**。
 *      外部から受け取るのは `YYYY-MM-DD` という閉じたトークン 1 個だけで、
 *      `/dispatch <branch> <N>` → `/impl <N>` を claude-hub 側で構築するのと同型。
 *      これが「本社セッションへ任意の指示を注入して承認ゲートを迂回する」ことに対する
 *      主防御になる。レポート本文は CEO セッションが自分で `~/corp` から読む。
 *   4. 投入先スレッドは `listRunningByChannel(<channel>)` で**決定的に**解決する。
 *      オーケストレーター（branch が `orchestrate-` 始まり）だけは機械的な印で
 *      候補から除き（{@link selectBriefTargets}）、残りがちょうど 1 件のときだけ
 *      注入する。0 件 / 2 件以上は注入せず通知する（推測で選ばない）。
 *   5. **稼働中セッションへ打鍵する唯一の外部トリガー**なので、割り込みの安全弁を 2 つ持つ:
 *      対象スレッドが AskUserQuestion の回答待ちなら注入しない（`askPending`）、
 *      同じ日付を直近に注入済みなら二度割り込まない（{@link BRIEF_DEDUP_WINDOW_MS}）。
 *      dispatch / orchestrate は**自分が起こしたばかりのセッション**にしか打鍵しないため
 *      この論点を持たない。ここだけは brief のほうが強い能力を持つ。
 *
 * *誰が* トリガーできるかは access policy 側の設定であり、本モジュールは corp 固有の
 * 送信元を一切ハードコードしない（`dispatch.ts` と同じ方針）。#corp が最初の利用者
 * というだけで、機構としては CHANNEL_MAP に載っている任意のチャンネルで動く。
 *
 * 判断はすべて純関数 {@link evaluateBriefTrigger} に閉じており、Discord ゲートウェイも
 * 実 SessionManager も無しで単体テストできる。副作用（注入・通知・投稿）は呼び出し元
 * （bot.ts）が持つ。
 */

import {
  envDispatchAllowedSourceIds,
  isDispatchSourceAllowed,
  type AccessPolicy,
  type DispatchDecisionReason,
} from "../config/access-policy";
import { ORCHESTRATE_BRANCH_PREFIX } from "./orchestrate";

/** リテラルのトリガートークン。corp 側が同じ文字列を post する。 */
export const BRIEF_PREFIX = "/brief";

/** kill-switch の env 名（corp 側 `CORP_DISPATCH_DISABLED` と対称）。 */
export const BRIEF_DISABLED_ENV = "CORP_BRIEF_DISABLED";

/** `YYYY-MM-DD` の形式チェック（実在日かどうかは別途カレンダー検証する）。 */
const BRIEF_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * この経路を止める kill-switch。`CORP_BRIEF_DISABLED` が空文字 / `0` 以外なら停止。
 * 「止める」方向は安全側なので、値の細かな解釈で迷わないよう緩めに判定する。
 */
export function isBriefDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[BRIEF_DISABLED_ENV] ?? "").trim();
  return raw.length > 0 && raw !== "0";
}

/**
 * `/brief` トークンで始まるメッセージか（`/briefing` などは対象外）。認可より前に
 * 走る安価な早期判定で、無関係なメッセージで access policy を読まないためにある。
 */
export function isBriefCommand(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === BRIEF_PREFIX || trimmed.startsWith(BRIEF_PREFIX + " ");
}

export type ParsedBrief =
  | { kind: "ok"; date: string }
  | { kind: "not_brief" }
  | { kind: "error"; reason: string };

/**
 * 実在する日付か。`2026-02-30` のような「形式は合っているが存在しない日」を弾く。
 * UTC で組み立ててからフィールドが保存されているかを見る（`new Date("2026-02-30")`
 * のような文字列パースはランタイム差でロールオーバーするため使わない）。
 */
function isRealDate(token: string): boolean {
  const m = BRIEF_DATE_RE.exec(token);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * `/brief <YYYY-MM-DD>` を厳格にパースする。引数は日付 1 個**だけ**で、それ以外は
 * すべて error（fail-closed）。自由文を通す余地をここで断つのが本モジュールの要。
 */
export function parseBriefCommand(content: string): ParsedBrief {
  if (!isBriefCommand(content)) return { kind: "not_brief" };

  const rest = content.trim().slice(BRIEF_PREFIX.length).trim();
  const parts = rest.length > 0 ? rest.split(/\s+/) : [];

  if (parts.length === 0) {
    return {
      kind: "error",
      reason: `日付が指定されていません（${BRIEF_PREFIX} <YYYY-MM-DD>）。`,
    };
  }
  if (parts.length > 1) {
    // 追加トークンを黙って捨てると「自由文を渡したつもり」が通ったように見える。
    // 拒否して呼び出し元に気付かせる。
    return {
      kind: "error",
      reason: `引数は日付 1 つだけです（${BRIEF_PREFIX} <YYYY-MM-DD>）。`,
    };
  }
  const date = parts[0] as string;
  if (!isRealDate(date)) {
    return {
      kind: "error",
      reason: "日付は YYYY-MM-DD 形式（実在する日付）で指定してください。",
    };
  }
  return { kind: "ok", date };
}

/**
 * セッションへ注入する文字列を組み立てる。**外部入力は検証済みの `date` だけ**で、
 * 残りは固定リテラル。`date` は {@link BRIEF_DATE_RE} を通過した数字とハイフンのみ
 * なので、テンプレートへ埋めても指示文を注入できない。
 *
 * relay は `tmux send-keys -l` の途中送信を避けるため改行を空白へ潰す
 * （`relay.ts` flattenForSendKeys）。潰される前提に依存しないよう最初から 1 行で作る。
 */
export function buildBriefInjection(date: string): string {
  return (
    `【朝レポ着信 ${date}】corp の朝レポ配信を claude-hub が検知しました。` +
    `~/corp の ${date} 分の朝レポ（CEO 提案 [D1]..[Dn]）を読み、` +
    `どの提案を承認するかを AskUserQuestion で会長に問うてください。` +
    `会長の回答を得るまで、dispatch など承認を要する操作は実行しないこと。`
  );
}

/** 投入先候補セッションの最小面（実 SessionInfo が構造的に満たす）。 */
export interface BriefSessionRef {
  threadId: string;
  branch?: string;
}

/**
 * 投入先の候補から、CEO セッションでないと**決定的に**判る行を除く。
 *
 * `listRunningByChannel` は channelName と status でしか絞らないため、#corp では
 * `/orchestrate` で起動したオーケストレーター（branch が
 * {@link ORCHESTRATE_BRANCH_PREFIX} 始まり）も同じ候補集合に入る。これを残すと
 * CEO セッションとの同時稼働で毎回 `ambiguous`（＝朝レポ未達）になる。
 *
 * 除外の根拠は `orchestrateBranchName()` が付ける固定 prefix という**機械的な印**
 * だけに限る（推測でセッションを選り分けない）。それ以外の候補が複数残る場合は
 * 従来どおり `ambiguous` に倒す。hub work セッションは channelName が
 * `claude-hub-work` なので、そもそも #corp の候補に入らない。
 */
export function selectBriefTargets(
  sessions: readonly BriefSessionRef[],
): BriefSessionRef[] {
  return sessions.filter(
    (s) => !(s.branch ?? "").startsWith(ORCHESTRATE_BRANCH_PREFIX),
  );
}

/**
 * 同じ日付の brief を再び受けても投入しない時間窓（冪等性）。
 *
 * corp 側の配信リトライや手動 re-post で同じ `(channel, date)` が二度来ると、
 * **稼働中の会話に二度割り込む**（`enqueueForThread` が直列化するので状態は壊れないが、
 * 会長との対話は二度中断される）。corp の dispatch スケジューラが 30 分周期なので、
 * その 1 サイクル分をまたいで吸収できる 60 分を既定にする。窓を無期限にしないのは、
 * 初回の注入がセッション側で活きなかったときに**同じ日付で意図的に再投入する**余地を
 * 残すため（無期限だと当日中は二度と起こせなくなる）。
 */
export const BRIEF_DEDUP_WINDOW_MS = 60 * 60_000;

/** 直近に注入済みの brief（冪等性判定の入力）。 */
export interface RecentBrief {
  date: string;
  atMs: number;
}

export interface BriefTriggerInput {
  /** 受信メッセージ本文。 */
  content: string;
  /** 送信先チャンネルの snowflake（access policy のキー）。 */
  channelId: string;
  /** 送信元（bot / webhook）の snowflake。 */
  sourceId: string;
  /** 読み込み済み access policy。`null` = 読めなかった（fail-closed で deny）。 */
  policy: AccessPolicy | null;
  /** 当該チャンネルで running のセッション（`listRunningByChannel` の結果）。 */
  sessions: BriefSessionRef[];
  /**
   * 対象スレッドで AskUserQuestion が保留中（またはその直後の猶予窓）か。
   *
   * **必須**（省略可にしない）。この経路は「既に走っていて状態の分からないセッション」へ
   * 打鍵する唯一の外部トリガーで、`sendToPane` は毎回先頭に `Escape` を送る。会長が
   * 回答を検討している最中に打てば、保留中の決裁が本人不在で消えるか、最悪 fallback
   * dialog の既定が選ばれる（#412 / #416 / #423 が閉じた失敗クラスそのもの）。
   * 呼び出し側は `hasRecentAsk`（= 保留中 + settle 直後の猶予）を渡すこと。
   */
  askPending: (threadId: string) => boolean;
  /**
   * 同じチャンネルで直近に注入した brief。`undefined` = 記録なし。
   * {@link BRIEF_DEDUP_WINDOW_MS} 以内に同じ日付が来たら投入しない。
   */
  recentBrief?: RecentBrief;
  /** 冪等性判定の基準時刻。省略時 `Date.now()`。 */
  nowMs?: number;
  /** kill-switch 判定用。省略時 `process.env`。 */
  env?: Record<string, string | undefined>;
  /** `DISPATCH_ALLOWED_SOURCE_IDS` 相当。省略時 env から読む（dispatch と共用）。 */
  envAllowedSourceIds?: string[];
}

/**
 * 判定結果。副作用は持たず、呼び出し元がこの action に応じて実行する。
 * `ignore` 以外はすべて「メッセージを消費した（通常処理へ流さない）」を意味する。
 */
export type BriefDecision =
  /** `/brief` ではない → 通常処理へ流す。 */
  | { action: "ignore" }
  /** kill-switch で停止中。 */
  | { action: "disabled" }
  /** 認可されない送信元 / チャンネル（fail-closed）。reason は粗い enum のみ。 */
  | { action: "denied"; reason: DispatchDecisionReason }
  /** 認可済みだがコマンドが不正。 */
  | { action: "rejected"; reason: string }
  /** 注入する（対象スレッドがちょうど 1 件）。 */
  | { action: "inject"; date: string; threadId: string; text: string }
  /** 同じ日付を直近に注入済み → 二度割り込まない（冪等性）。 */
  | { action: "duplicate"; date: string; elapsedMs: number }
  /** 対象セッションが会長の回答待ち → 注入せず通知（割り込まない）。 */
  | { action: "deferred"; date: string; threadId: string }
  /** 稼働中セッションが無い → 注入せず通知（サイレントに落とさない）。 */
  | { action: "no_session"; date: string }
  /** 稼働中セッションが複数 → 曖昧なので注入せず通知（推測で選ばない）。 */
  | { action: "ambiguous"; date: string; count: number };

/**
 * トリガーの可否と投入先を決める純関数。評価順は次で固定する:
 *
 *   1. `/brief` か（安価な形式判定。違えば policy を読まない）
 *   2. kill-switch
 *   3. **認可**（fail-closed。ここを通らなければパースもしない）
 *   4. コマンドのパース（自由文を拒否）
 *   5. 冪等性（同じ日付を直近に注入済みなら二度割り込まない）
 *   6. 投入先スレッドの決定（1 件のときだけ先へ進む）
 *   7. **回答待ちの割り込み回避**（保留中なら注入しない）
 *
 * 3 が 4 より先なのは既存 `handleDispatchMessage` と同じ順序で、認可されない送信元の
 * 入力を一切解釈しないため（`tests/guards/access-enforcement-wired.test.ts` が
 * dispatch と同様にこの順序を固定する）。7 が最後なのは、対象スレッドが確定して
 * 初めて「そのスレッドが回答待ちか」を問えるため。
 */
export function evaluateBriefTrigger(input: BriefTriggerInput): BriefDecision {
  if (!isBriefCommand(input.content)) return { action: "ignore" };

  if (isBriefDisabled(input.env ?? process.env)) {
    return { action: "disabled" };
  }

  const decision = isDispatchSourceAllowed(
    input.policy,
    input.channelId,
    input.sourceId,
    input.envAllowedSourceIds ?? envDispatchAllowedSourceIds(),
  );
  if (!decision.allowed) {
    return { action: "denied", reason: decision.reason };
  }

  const parsed = parseBriefCommand(input.content);
  if (parsed.kind === "not_brief") {
    // isBriefCommand を通った以上ここへは来ないが、fail-closed に倒す
    // （黙って通常処理へ流さない）。
    return { action: "rejected", reason: "コマンド形式が不正です。" };
  }
  if (parsed.kind === "error") {
    return { action: "rejected", reason: parsed.reason };
  }

  const { date } = parsed;

  // 冪等性: 同じ日付を直近に注入済みなら、稼働中の会話へ二度割り込まない。
  // 記録は inject したときだけ残す契約なので、no_session / deferred で終わった
  // brief の再送はここで止まらない（止めると回復手段が消える）。
  const now = input.nowMs ?? Date.now();
  const recent = input.recentBrief;
  if (recent && recent.date === date) {
    const elapsedMs = now - recent.atMs;
    if (elapsedMs >= 0 && elapsedMs < BRIEF_DEDUP_WINDOW_MS) {
      return { action: "duplicate", date, elapsedMs };
    }
  }

  const sessions = selectBriefTargets(input.sessions);
  if (sessions.length === 0) {
    return { action: "no_session", date };
  }
  if (sessions.length > 1) {
    return { action: "ambiguous", date, count: sessions.length };
  }

  const threadId = (sessions[0] as BriefSessionRef).threadId;

  // 会長が AskUserQuestion に回答している最中（およびその直後の猶予窓）には
  // 打鍵しない。人間の relay 経路は同じ状況で tmux へ流さず resolveAskUser へ
  // 回している（bot.ts / #370）。こちらは Discord の返信ではなく生の打鍵で、
  // しかも `sendToPane` は先頭に Escape を送るため、割り込みの害はより大きい。
  // no_session / ambiguous と同じ「推測で触らない」方針の延長。
  if (input.askPending(threadId)) {
    return { action: "deferred", date, threadId };
  }

  return {
    action: "inject",
    date,
    threadId,
    text: buildBriefInjection(date),
  };
}
