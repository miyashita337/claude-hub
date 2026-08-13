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
 *   5. 投入先スレッドの決定（1 件のときだけ inject）
 *
 * 3 が 4 より先なのは既存 `handleDispatchMessage` と同じ順序で、認可されない送信元の
 * 入力を一切解釈しないため（`tests/guards/access-enforcement-wired.test.ts` が
 * dispatch と同様にこの順序を固定する）。
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
  const sessions = selectBriefTargets(input.sessions);
  if (sessions.length === 0) {
    return { action: "no_session", date };
  }
  if (sessions.length > 1) {
    return { action: "ambiguous", date, count: sessions.length };
  }

  return {
    action: "inject",
    date,
    threadId: (sessions[0] as BriefSessionRef).threadId,
    text: buildBriefInjection(date),
  };
}
