/**
 * 朝レポ契機のタップ決裁トリガー（#426 → #449 / corp#112 の AC-1）。
 *
 * corp が朝レポ（CEO 提案 `[D1]..[Dn]`）を #corp へ配信しても、`bot.ts` の
 * `if (message.author.bot) return;` が bot / webhook のメッセージを一律 drop する
 * ため、「朝レポが来た」ことを起点に決裁ジャーニーを始める主体が居ない。
 *
 * #426 は「稼働中の CEO セッションへ注入して AskUserQuestion を出させる」設計だったが、
 * Mac / supervisor 再起動のたびに `/session start` の手動再実行が前提になり、
 * 2026-08-23 朝の実機観測でセッション不在（no_session）により決裁が止まった。
 * #449（会長決裁・案 A）で **セッション非依存** に置き換える:
 *
 *   1. トリガーは既知チャンネルの**非スレッド**メッセージ `/brief <YYYY-MM-DD>`。
 *      corp の朝レポ配信 webhook ではなく、corp の **dispatch bot**（別 identity）が
 *      post する。webhook URL はそれ自体が bearer credential であり、かつ自由文の
 *      レポート本文を運ぶ経路でもあるため、権限（トリガー）と内容（本文）を別
 *      identity に分けておく。
 *   2. 認可は {@link isDispatchSourceAllowed} を**そのまま**再利用する。policy 不在 /
 *      channel 未登録 / `dispatchFrom` 未列挙 の 3 つの deny がそのまま効く
 *      （fail-closed）。新しい認可モデルを書かない = 新しい抜け道を作らない。
 *   3. **外部から受け取るのは `YYYY-MM-DD` という閉じたトークン 1 個だけ**。
 *      提案の実体（id / タイトル / 未決状態）は claude-hub 自身が対象チャンネルの
 *      作業ディレクトリで `proposals --json`（corp CLI）を実行して取得する
 *      （brief-decision.ts）。自由文を一切受け取らない性質は #426 と同じ。
 *   4. 決裁の実行者は**会長のボタンタップのみ**（brief-decision.ts が access.json の
 *      `allowFrom` で検証する）。この評価器はどのセッションにも触れない —
 *      セッションへの打鍵という能力自体を持たないため、#426 が持っていた
 *      askPending / no_session / ambiguous / deferred の各安全弁は不要になった。
 *
 * *誰が* トリガーできるかは access policy 側の設定であり、本モジュールは corp 固有の
 * 送信元を一切ハードコードしない（`dispatch.ts` と同じ方針）。#corp が最初の利用者
 * というだけで、機構としては CHANNEL_MAP + `ChannelConfig.brief` が設定された任意の
 * チャンネルで動く。
 *
 * 判断はすべて純関数 {@link evaluateBriefTrigger} に閉じており、Discord ゲートウェイ
 * 無しで単体テストできる。副作用（CLI 実行・投稿）は呼び出し元（bot.ts）が持つ。
 */

import {
  envDispatchAllowedSourceIds,
  isDispatchSourceAllowed,
  type AccessPolicy,
  type DispatchDecisionReason,
} from "../config/access-policy";

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
 * 同じ日付の brief を再び受けても決裁メッセージを出し直さない時間窓（冪等性）。
 *
 * corp 側の配信リトライや手動 re-post で同じ `(channel, date)` が二度来ると、
 * 同じ未決提案のボタンがチャンネルに二重に並ぶ（decide-proposal 自体は corp 側で
 * 冪等だが、どちらのメッセージが生きているか会長には判別できない）。corp の
 * dispatch スケジューラが 30 分周期なので、その 1 サイクル分をまたいで吸収できる
 * 60 分を既定にする。窓を無期限にしないのは、決裁メッセージの post に失敗した
 * とき**同じ日付で意図的に再投入する**余地を残すため。
 */
export const BRIEF_DEDUP_WINDOW_MS = 60 * 60_000;

/** 直近に処理済みの brief（冪等性判定の入力）。 */
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
  /**
   * 同じチャンネルで直近に処理した brief。`undefined` = 記録なし。
   * {@link BRIEF_DEDUP_WINDOW_MS} 以内に同じ日付が来たら再処理しない。
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
  /** 未決提案を取得して決裁メッセージをチャンネル直下へ post する（#449）。 */
  | { action: "decide"; date: string }
  /** 同じ日付を直近に処理済み → 決裁メッセージを二重に出さない（冪等性）。 */
  | { action: "duplicate"; date: string; elapsedMs: number };

/**
 * トリガーの可否を決める純関数。評価順は次で固定する:
 *
 *   1. `/brief` か（安価な形式判定。違えば policy を読まない）
 *   2. kill-switch
 *   3. **認可**（fail-closed。ここを通らなければパースもしない）
 *   4. コマンドのパース（自由文を拒否）
 *   5. 冪等性（同じ日付を直近に処理済みなら決裁メッセージを出し直さない）
 *
 * 3 が 4 より先なのは既存 `handleDispatchMessage` と同じ順序で、認可されない送信元の
 * 入力を一切解釈しないため（`tests/guards/access-enforcement-wired.test.ts` が
 * dispatch と同様にこの順序を固定する）。#426 にあった投入先セッションの決定
 * （6）と回答待ちの割り込み回避（7）は、セッションへ触れない #449 では存在しない。
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

  // 冪等性: 同じ日付を直近に処理済みなら、決裁メッセージを二重に出さない。
  // 記録は decide 側の post 成功時だけ残す契約なので、CLI 失敗 / post 失敗で
  // 終わった brief の再送はここで止まらない（止めると回復手段が消える）。
  const now = input.nowMs ?? Date.now();
  const recent = input.recentBrief;
  if (recent && recent.date === date) {
    const elapsedMs = now - recent.atMs;
    if (elapsedMs >= 0 && elapsedMs < BRIEF_DEDUP_WINDOW_MS) {
      return { action: "duplicate", date, elapsedMs };
    }
  }

  return { action: "decide", date };
}
