/**
 * 朝レポ「窓口セッション」（#454）— ボタン決裁以外の返信を受ける会話口。
 *
 * #449 で朝レポの決裁はセッション非依存のボタンになった。堅牢さと引き換えに、
 * 会長が「OK / NG 以外」を返す口が消えている。#corp のチャンネル直下に書いた
 * メッセージはどのセッションにも中継されないため（`bot.ts` の
 * `if (!message.channel.isThread()) return;`）、受け口はスレッドしか有り得ない。
 *
 * そこで `/brief <YYYY-MM-DD>` の着信を契機に、決裁ボタンと**並行して**
 * 会話用スレッドを 1 本開き、corp の CEO セッションを起動する。
 *
 * 設計上の約束:
 *
 *   1. **自由文を受け取らない**（#449 の不変条件を継承）。注入するのは
 *      検証済みの `YYYY-MM-DD` から組み立てた固定リテラル `/brief-window <date>`
 *      だけで、送信者のテキストは 1 バイトも通らない。実際の振る舞いは corp 側の
 *      `.claude/commands/brief-window.md`（corp#136）が持つ = 部署の playbook は
 *      部署リポに置く（corp#49 の決定）。
 *   2. **決裁経路と独立**。窓口の起動に失敗しても決裁ボタンは生きている。
 *      逆に決裁の post に失敗した朝こそ窓口が要るので、`delivered` の真偽に
 *      関わらず開こうとする。
 *   3. **冪等**。窓口は同名スレッド（`朝レポ窓口 <date>`）で識別する。同じ業務日の
 *      `/brief` が再送されても、生きている窓口があればそれを再利用する。
 *      thread id を supervisor のメモリに持たないので、再起動を跨いでも壊れない。
 *   4. **停止機構を足さない**。生存期間は interactive セッション共通の idle reaper
 *      （`SESSION_IDLE_DEFAULT_MS`、既定 6h）に委ねる。閉じた後にそのスレッドへ
 *      発言されたら {@link evaluateBriefWindowRestart} 経由で起動し直す。
 *
 * 判断はすべて純関数に閉じており、副作用は {@link BriefWindowDeps} として注入する
 * （`corp-brief.ts` / `dispatch.ts` と同じ設計方針）。
 */

/** 窓口だけを止める kill-switch。決裁経路の `CORP_BRIEF_DISABLED` とは独立。 */
export const BRIEF_WINDOW_DISABLED_ENV = "CORP_BRIEF_WINDOW_DISABLED";

/** 窓口スレッド名の接頭辞。この文字列が窓口スレッドの識別子そのもの。 */
export const BRIEF_WINDOW_THREAD_PREFIX = "朝レポ窓口";

/** 注入するスラッシュコマンド名（定義は corp 側 `.claude/commands/brief-window.md`）。 */
export const BRIEF_WINDOW_COMMAND = "brief-window";

/** 窓口 worktree のブランチ接頭辞。dispatch の `corp-dispatch-<N>` と同じ命名思想。 */
export const BRIEF_WINDOW_BRANCH_PREFIX = "corp-brief-window-";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 日付トークンの再検証。呼び出し元（`parseBriefCommand`）が既に検証済みでも、
 * ここを通らない限りスレッド名・ブランチ名・注入文字列のどれにも値が入らないようにする。
 * 不正値は握りつぶさず throw する（silent fallback 禁止）。
 */
function assertDate(date: string): string {
  if (!DATE_RE.test(date)) {
    throw new Error(
      `brief-window: 日付が YYYY-MM-DD ではありません（注入・命名に使えません）: ${date}`,
    );
  }
  return date;
}

/** この経路を止める kill-switch。空文字 / `0` 以外なら停止（`isBriefDisabled` と同型）。 */
export function isBriefWindowDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[BRIEF_WINDOW_DISABLED_ENV] ?? "").trim();
  return raw.length > 0 && raw !== "0";
}

/** 窓口スレッド名。この名前が (channel, 業務日) に対する冪等キーになる。 */
export function briefWindowThreadName(date: string): string {
  return `${BRIEF_WINDOW_THREAD_PREFIX} ${assertDate(date)}`;
}

/** 窓口 worktree のブランチ名。branchless（`~/corp` 直）だと #150 の relay-url 衝突を踏む。 */
export function briefWindowBranch(date: string): string {
  return `${BRIEF_WINDOW_BRANCH_PREFIX}${assertDate(date)}`;
}

/** セッションへ注入する固定リテラル。送信者のテキストはここに一切入らない。 */
export function briefWindowInitialCommand(date: string): string {
  return `/${BRIEF_WINDOW_COMMAND} ${assertDate(date)}`;
}

/**
 * スレッド名から窓口の業務日を取り出す。窓口でなければ `null`。
 *
 * 名前で識別するのは、この名前を付けたのが supervisor 自身だから（外部 UI の
 * 表示文字列マッチ = RW-027 の anti-pattern ではない）。人が改名した窓口は
 * 自動再起動の対象外に落ちるが、従来どおり salvage 返信が出るだけで壊れない。
 */
export function parseBriefWindowThreadName(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const prefix = `${BRIEF_WINDOW_THREAD_PREFIX} `;
  if (!name.startsWith(prefix)) return null;
  const date = name.slice(prefix.length).trim();
  return DATE_RE.test(date) ? date : null;
}

/** 窓口を開かない理由。すべて呼び出し元が観測・報告できるよう列挙する。 */
export type BriefWindowSkipReason =
  | "disabled"
  | "no_brief_config"
  | "invalid_date"
  | "capacity"
  | "not_window_thread"
  | "session_alive";

export type BriefWindowOpenDecision =
  | {
      kind: "open";
      date: string;
      threadName: string;
      branch: string;
      command: string;
    }
  | { kind: "skip"; reason: BriefWindowSkipReason };

export interface BriefWindowOpenInput {
  /** `parseBriefCommand` が検証済みの業務日。 */
  date: string;
  /** 対象チャンネルに `ChannelConfig.brief` があるか（無ければ窓口も対象外）。 */
  hasBriefConfig: boolean;
  /** 現在の稼働セッション数。 */
  sessionCount: number;
  /** `MAX_SESSIONS`。 */
  maxSessions: number;
  env?: Record<string, string | undefined>;
}

/**
 * 窓口を開いてよいかの判定。決裁経路（`evaluateBriefTrigger`）とは独立に
 * fail-closed で判断する — 認可自体は呼び出し元が既に通した `/brief` の
 * `dispatchFrom` ゲートが担う（新しい認可モデルを作らない）。
 */
export function evaluateBriefWindowOpen(
  input: BriefWindowOpenInput,
): BriefWindowOpenDecision {
  if (isBriefWindowDisabled(input.env ?? process.env)) {
    return { kind: "skip", reason: "disabled" };
  }
  if (!input.hasBriefConfig) {
    return { kind: "skip", reason: "no_brief_config" };
  }
  if (!DATE_RE.test(input.date)) {
    return { kind: "skip", reason: "invalid_date" };
  }
  if (input.sessionCount >= input.maxSessions) {
    return { kind: "skip", reason: "capacity" };
  }
  return {
    kind: "open",
    date: input.date,
    threadName: briefWindowThreadName(input.date),
    branch: briefWindowBranch(input.date),
    command: briefWindowInitialCommand(input.date),
  };
}

export type BriefWindowRestartDecision =
  | { kind: "restart"; date: string; branch: string; command: string }
  | { kind: "skip"; reason: BriefWindowSkipReason };

export interface BriefWindowRestartInput {
  /** 発言のあったスレッド名。 */
  threadName: string | null | undefined;
  hasBriefConfig: boolean;
  /** そのスレッドに稼働セッションがあるか。 */
  hasSession: boolean;
  sessionCount: number;
  maxSessions: number;
  env?: Record<string, string | undefined>;
}

/**
 * idle reaper に閉じられた窓口スレッドへの発言で、セッションを起動し直してよいかの判定。
 * 窓口スレッド以外は従来どおり salvage 返信に任せる（`not_window_thread`）。
 */
export function evaluateBriefWindowRestart(
  input: BriefWindowRestartInput,
): BriefWindowRestartDecision {
  const date = parseBriefWindowThreadName(input.threadName);
  if (date === null) {
    return { kind: "skip", reason: "not_window_thread" };
  }
  if (isBriefWindowDisabled(input.env ?? process.env)) {
    return { kind: "skip", reason: "disabled" };
  }
  if (!input.hasBriefConfig) {
    return { kind: "skip", reason: "no_brief_config" };
  }
  if (input.hasSession) {
    return { kind: "skip", reason: "session_alive" };
  }
  if (input.sessionCount >= input.maxSessions) {
    return { kind: "skip", reason: "capacity" };
  }
  return {
    kind: "restart",
    date,
    branch: briefWindowBranch(date),
    command: briefWindowInitialCommand(date),
  };
}

/**
 * 初期コマンド注入に対して relay が返した応答（#464）。
 *
 * `chunks` を捨てると CEO の待機報告がどこにも出ない。通常の会話経路は同じ値を
 * スレッドへ投稿しており、窓口だけがそれを持っていなかった。
 */
export interface BriefWindowRelayReply {
  chunks: string[];
  error?: string;
}

/** 窓口を開くために必要な副作用。Discord / SessionManager を直接触らないための注入点。 */
export interface BriefWindowDeps {
  /** 同名の生存スレッドを探す（冪等キー）。見つからなければ null。 */
  findThreadByName: (name: string) => Promise<{ id: string } | null>;
  /** そのスレッドに稼働セッションがあるか。 */
  hasSession: (threadId: string) => boolean;
  createThread: (name: string) => Promise<{ id: string }>;
  start: (threadId: string, branch: string) => Promise<void>;
  waitForInputReady: (threadId: string) => Promise<boolean>;
  sendMessage: (
    threadId: string,
    text: string,
  ) => Promise<BriefWindowRelayReply>;
  postToThread: (threadId: string, content: string) => Promise<void>;
  postToChannel: (content: string) => Promise<void>;
  notifyFailure: (title: string, body: string) => Promise<void>;
}

/**
 * 窓口スレッドへの着信メッセージをどう処理したか（#463）。
 *
 * `not_window` 以外を返した時点で、呼び出し元は汎用 auto-resume（#456）へ
 * 落としてはならない。窓口スレッドにも履歴があるため、素の `--resume` が先に
 * 噛むと「窓口を止めたのに窓口が起き上がる」ようになる。
 */
export type BriefWindowMessageOutcome = "restarted" | "blocked" | "not_window";

export type BriefWindowResult =
  | { ok: true; threadId: string; reused: boolean }
  | {
      ok: false;
      stage: "skipped" | "thread" | "start" | "inject";
      reason: string;
    };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 窓口を開く（朝レポ着信時の eager 経路）。
 *
 * 失敗は必ずチャンネルに出す。決裁ボタンは呼び出し元が別に post 済みなので、
 * ここで throw して決裁ごと巻き添えにしない（結果型で返す）。
 */
export async function openBriefWindow(
  input: BriefWindowOpenInput,
  deps: BriefWindowDeps,
): Promise<BriefWindowResult> {
  const decision = evaluateBriefWindowOpen(input);
  if (decision.kind === "skip") {
    // 意図的な停止（kill-switch / 未設定チャンネル）は「失敗」ではないので黙る。
    // 開けるはずが開けなかった理由（capacity / invalid_date）だけを可視化する。
    if (decision.reason === "capacity" || decision.reason === "invalid_date") {
      const detail =
        decision.reason === "capacity"
          ? `稼働セッションが上限（${input.maxSessions}）に達しているため起動できませんでした`
          : `日付トークンが不正でした（${input.date}）`;
      await deps
        .postToChannel(
          `⚠️ 朝レポ（${input.date}）の窓口スレッドを開けませんでした — ${detail}。\n` +
            `決裁ボタンは通常どおり使えます。会話が必要なら \`/session start <branch>\` でスレッドを作ってください。`,
        )
        .catch((err) =>
          console.warn("[brief-window] skip notice post failed:", err),
        );
    }
    return { ok: false, stage: "skipped", reason: decision.reason };
  }

  // 冪等キー = スレッド名。生きている窓口があれば何もしない（同日 2 本作らない）。
  let threadId: string;
  let reused = false;
  try {
    const existing = await deps.findThreadByName(decision.threadName);
    if (existing) {
      if (deps.hasSession(existing.id)) {
        return { ok: true, threadId: existing.id, reused: true };
      }
      // スレッドはあるがセッションが落ちている（reaper 後の再送）→ 貼り直す。
      threadId = existing.id;
    } else {
      threadId = (await deps.createThread(decision.threadName)).id;
    }
  } catch (err) {
    const reason = errMsg(err);
    console.error(`[brief-window] thread resolution failed: ${reason}`);
    await deps
      .postToChannel(
        `⚠️ 朝レポ（${decision.date}）の窓口スレッドを作成できませんでした（決裁ボタンは有効）。\n\`\`\`\n${reason}\n\`\`\``,
      )
      .catch(() => {});
    await deps
      .notifyFailure(
        "朝レポ窓口の起動に失敗",
        `${decision.date} の窓口スレッドを作成できませんでした: ${reason}`,
      )
      .catch(() => {});
    return { ok: false, stage: "thread", reason };
  }

  return startWindowSession(decision.date, threadId, decision.branch, decision.command, deps, reused);
}

/**
 * 閉じた窓口スレッドへの発言でセッションを起動し直す（lazy 経路）。
 * スレッドは既にあるので、起動と注入だけを行う。
 */
export async function restartBriefWindow(
  input: BriefWindowRestartInput,
  threadId: string,
  deps: BriefWindowDeps,
): Promise<BriefWindowResult> {
  const decision = evaluateBriefWindowRestart(input);
  if (decision.kind === "skip") {
    if (decision.reason === "capacity") {
      await deps
        .postToThread(
          threadId,
          `⚠️ 稼働セッションが上限に達しているため、この窓口を再開できませんでした。` +
            `他のセッションを止めてからもう一度発言してください。`,
        )
        .catch((err) =>
          console.warn("[brief-window] capacity notice post failed:", err),
        );
    }
    return { ok: false, stage: "skipped", reason: decision.reason };
  }

  return startWindowSession(
    decision.date,
    threadId,
    decision.branch,
    decision.command,
    deps,
    false,
  );
}

/** 起動 → input-ready 待ち → 固定コマンド注入。eager / lazy で共通。 */
async function startWindowSession(
  date: string,
  threadId: string,
  branch: string,
  command: string,
  deps: BriefWindowDeps,
  reused: boolean,
): Promise<BriefWindowResult> {
  try {
    await deps.start(threadId, branch);
  } catch (err) {
    const reason = errMsg(err);
    console.error(`[brief-window] session start failed (${threadId}): ${reason}`);
    await deps
      .postToChannel(
        `⚠️ 朝レポ（${date}）の窓口セッションを起動できませんでした（決裁ボタンは有効）。\n\`\`\`\n${reason}\n\`\`\``,
      )
      .catch(() => {});
    await deps
      .notifyFailure(
        "朝レポ窓口の起動に失敗",
        `${date} の窓口セッションを起動できませんでした: ${reason}`,
      )
      .catch(() => {});
    return { ok: false, stage: "start", reason };
  }

  // start() は PID までしか待たない。起動直後の Ink TUI に打つと先頭の `/` を
  // スラッシュピッカーが食って入力欄に取り残される（RW-025 / RW-047 と同じ
  // タイミング事故）。marker を待ってから注入し、待てなくても best-effort で打つ。
  try {
    const ready = await deps.waitForInputReady(threadId);
    if (!ready) {
      console.warn(
        `[brief-window] input-ready marker not seen for thread ${threadId}; injecting anyway`,
      );
    }
  } catch (err) {
    console.warn(
      `[brief-window] waitForInputReady failed for thread ${threadId}: ${errMsg(err)}`,
    );
  }

  let reply: BriefWindowRelayReply;
  try {
    reply = await deps.sendMessage(threadId, command);
  } catch (err) {
    const reason = errMsg(err);
    console.error(`[brief-window] inject failed (${threadId}): ${reason}`);
    await deps
      .postToThread(
        threadId,
        `⚠️ 窓口セッションは起動しましたが初期コマンド \`${command}\` を注入できませんでした。\n` +
          `このスレッドで直接話しかけるか、\`@Channel-Supervisor status\` で生死を確認してください。\n\`\`\`\n${reason}\n\`\`\``,
      )
      .catch(() => {});
    await deps
      .notifyFailure(
        "朝レポ窓口の初期化に失敗",
        `${date} の窓口へ ${command} を注入できませんでした: ${reason}`,
      )
      .catch(() => {});
    return { ok: false, stage: "inject", reason };
  }

  await deliverStandbyReport(threadId, reply, deps);

  return { ok: true, threadId, reused };
}

/**
 * 初期コマンドへの応答（＝CEO の待機報告）をスレッドへ出す（#464）。
 *
 * 投稿の失敗で窓口の起動そのものを巻き戻さない。窓口は既に使える状態であり、
 * 挨拶が出ないことと窓口が無いことは別物だから。ただし黙って捨てもしない。
 */
async function deliverStandbyReport(
  threadId: string,
  reply: BriefWindowRelayReply,
  deps: BriefWindowDeps,
): Promise<void> {
  const chunks = reply.chunks.filter((c) => c.trim().length > 0);

  for (const chunk of chunks) {
    try {
      await deps.postToThread(threadId, chunk);
    } catch (err) {
      console.error(
        `[brief-window] standby report post failed (${threadId}): ${errMsg(err)}`,
      );
    }
  }

  if (reply.error) {
    await deps
      .postToThread(
        threadId,
        `${BRIEF_WINDOW_REPLY_ERROR_NOTICE}\n\`\`\`\n${reply.error}\n\`\`\``,
      )
      .catch(() => {});
    return;
  }

  if (chunks.length === 0) {
    // 応答ゼロを「成功」として黙らせない（agent-output-quality #1）。
    await deps
      .postToThread(threadId, BRIEF_WINDOW_EMPTY_REPLY_NOTICE)
      .catch(() => {});
  }
}

/* --------------------------------------------------------------------------
 * bot.ts を薄く保つためのアダプタ層。
 *
 * discord.js / SessionManager の型は構造的に受け取り、ここでは import しない。
 * bot.ts 側に残すのは「実物をこの形に束ねる」数行だけにして、判断もログも
 * 通知文もこのファイル（= テストのあるファイル）に置く。
 * ------------------------------------------------------------------------ */

/** 親チャンネル（スレッドを作れるテキストチャンネル）に必要な最小形。 */
export interface BriefWindowChannelLike {
  threads: {
    fetchActive: () => Promise<{
      threads: {
        find: (
          predicate: (t: { name: string; id: string }) => boolean,
        ) => { id: string } | undefined;
      };
    }>;
    create: (options: {
      name: string;
      autoArchiveDuration: number;
    }) => Promise<{ id: string }>;
  };
  send: (content: string) => Promise<unknown>;
}

/** SessionManager に必要な最小形（config は呼び出し元で bind 済み）。 */
export interface BriefWindowSessionsLike {
  has: (threadId: string) => boolean;
  start: (threadId: string, branch: string) => Promise<void>;
  waitForInputReady: (threadId: string) => Promise<boolean>;
  sendMessage: (
    threadId: string,
    text: string,
  ) => Promise<BriefWindowRelayReply>;
}

/** dispatch スレッドと同じ 7 日。窓口は idle reaper 側で先に閉じる。 */
export const BRIEF_WINDOW_AUTO_ARCHIVE_MINUTES = 10080;

/** Discord / SessionManager から {@link BriefWindowDeps} を組み立てる。 */
export function createBriefWindowDeps(args: {
  channel: BriefWindowChannelLike;
  sessions: BriefWindowSessionsLike;
  /** スレッド id から送信口を引く（見つからなければ null）。 */
  fetchThread: (
    threadId: string,
  ) => Promise<{ send: (content: string) => Promise<unknown> } | null>;
  notifyFailure: (title: string, body: string) => Promise<void>;
}): BriefWindowDeps {
  return {
    findThreadByName: async (name) => {
      const active = await args.channel.threads.fetchActive();
      const hit = active.threads.find((t) => t.name === name);
      return hit ? { id: hit.id } : null;
    },
    hasSession: (threadId) => args.sessions.has(threadId),
    createThread: async (name) =>
      args.channel.threads.create({
        name,
        autoArchiveDuration: BRIEF_WINDOW_AUTO_ARCHIVE_MINUTES,
      }),
    start: (threadId, branch) => args.sessions.start(threadId, branch),
    waitForInputReady: (threadId) => args.sessions.waitForInputReady(threadId),
    sendMessage: (threadId, text) => args.sessions.sendMessage(threadId, text),
    postToThread: async (threadId, content) => {
      const thread = await args.fetchThread(threadId);
      if (thread) await thread.send(content);
    },
    postToChannel: async (content) => {
      await args.channel.send(content);
    },
    notifyFailure: args.notifyFailure,
  };
}

/**
 * eager 経路のエントリ。`/brief` 受理後に呼ぶ。
 *
 * 窓口は決裁の付随機能なので、ここで throw して決裁経路を巻き添えにしない
 * （失敗は結果型 + ログで返す）。
 */
export async function openBriefWindowForBrief(args: {
  date: string;
  channelName: string;
  sessionCount: number;
  maxSessions: number;
  deps: BriefWindowDeps;
  env?: Record<string, string | undefined>;
}): Promise<BriefWindowResult> {
  try {
    const result = await openBriefWindow(
      {
        date: args.date,
        hasBriefConfig: true,
        sessionCount: args.sessionCount,
        maxSessions: args.maxSessions,
        env: args.env,
      },
      args.deps,
    );
    if (result.ok) {
      console.log(
        `[brief-window] ${result.reused ? "reused" : "opened"} in channel ${args.channelName} (thread=${result.threadId}, date=${args.date})`,
      );
    } else {
      console.warn(
        `[brief-window] not opened in channel ${args.channelName} (stage=${result.stage}, reason=${result.reason})`,
      );
    }
    return result;
  } catch (err) {
    const reason = errMsg(err);
    console.error(`[brief-window] unexpected error in ${args.channelName}: ${reason}`);
    return { ok: false, stage: "skipped", reason };
  }
}

/** 再起動時にスレッドへ出す案内。引き金になった発言は中継しないことを明示する。 */
/** 応答が 1 つも返らなかったとき（#464）。無言で成功扱いにしない。 */
export const BRIEF_WINDOW_EMPTY_REPLY_NOTICE =
  "⚠️ 窓口セッションは起動しましたが、待機報告が返りませんでした。" +
  "このスレッドで話しかければ通常どおり応答します。";

/** 応答が error で返ったとき（#464）。 */
export const BRIEF_WINDOW_REPLY_ERROR_NOTICE =
  "⚠️ 窓口セッションは起動しましたが、待機報告の取得に失敗しました。" +
  "このスレッドで話しかければ通常どおり応答します。";

/** kill-switch で窓口を止めているとき（#463）。汎用 auto-resume に落とさない。 */
export const BRIEF_WINDOW_DISABLED_NOTICE =
  "⏸️ 窓口の自動再起動は停止中です（kill-switch 有効）。\n" +
  "会話を続けるには、このスレッドで `/session resume` を実行してください。";

/**
 * 窓口スレッドと判定できたが、親チャンネル / その設定を解決できないとき（#463）。
 *
 * ここで `not_window` を返して汎用 wake に落とすと、素の `--resume` が #454 の
 * 契約を黙って上書きする。解決失敗は「窓口ではない」ではなく「今は起こせない」。
 */
export const BRIEF_WINDOW_UNRESOLVED_NOTICE =
  "⚠️ 窓口スレッドの親チャンネルを解決できず、窓口を再開できませんでした。\n" +
  "しばらく待って再度発言するか、このスレッドで `/session resume` を実行してください。";

/** 親チャンネルに朝レポ設定が無いとき（#463）。設定ミスなので黙らせない。 */
export const BRIEF_WINDOW_NO_CONFIG_NOTICE =
  "⚠️ このチャンネルは朝レポ窓口として設定されていないため、窓口を再開できません。";

/**
 * スレッド名で窓口と確定した「あと」に、親チャンネル（`parent`）またはその
 * チャンネル設定（`CHANNEL_MAP`）を解決できなかったときの応答（#463）。
 *
 * 要点は **"not_window" を返さないこと**。解決失敗は「窓口ではない」ではなく
 * 「今は起こせない」であり、汎用 wake（#456）に落とすと素の `--resume` が
 * #454 の契約を黙って上書きする（supervisor 再起動直後のキャッシュミスで実際に
 * 起こる）。bot.ts に分岐を書くとテストが届かないため判断はここに置く。
 */
export function briefWindowResolutionFailure(stage: "parent" | "config"): {
  outcome: BriefWindowMessageOutcome;
  notice: string;
} {
  return {
    outcome: "blocked",
    notice:
      stage === "parent"
        ? BRIEF_WINDOW_UNRESOLVED_NOTICE
        : BRIEF_WINDOW_NO_CONFIG_NOTICE,
  };
}

/**
 * 解決失敗を通知まで含めて処理する（#463）。bot.ts 側は分岐 1 行で済ませる。
 *
 * 通知に失敗しても判定（`"blocked"`）は変えない。汎用 wake へ落とさないことが
 * 目的であって、通知はそのついでだから。
 */
export async function reportBriefWindowResolutionFailure(
  stage: "parent" | "config",
  threadId: string,
  send: (content: string) => Promise<unknown>,
): Promise<BriefWindowMessageOutcome> {
  const { outcome, notice } = briefWindowResolutionFailure(stage);
  console.warn(
    `[brief-window] ${stage} unresolved for window thread ${threadId}`,
  );
  try {
    await send(notice);
  } catch (err) {
    console.error(`[brief-window] resolution notice failed (${threadId}):`, err);
  }
  return outcome;
}

export const BRIEF_WINDOW_RESTART_NOTICE =
  "🔓 窓口セッションを再起動しました（前回は無操作で自動クローズされていました）。\n" +
  "起動処理中のため、いまの発言はまだ届いていません。**もう一度送ってください**。";

/**
 * lazy 経路のエントリ。セッション不在スレッドへの発言で呼ぶ。
 *
 * 戻り値 `true` = このメッセージを消費した（呼び出し元は以降の salvage 処理を
 * 止める）。`false` = 窓口ではない等で、従来の salvage 返信に委ねる。
 */
export async function handleBriefWindowThreadMessage(args: {
  threadId: string;
  threadName: string;
  hasBriefConfig: boolean;
  sessionCount: number;
  maxSessions: number;
  deps: BriefWindowDeps;
  env?: Record<string, string | undefined>;
}): Promise<BriefWindowMessageOutcome> {
  const result = await restartBriefWindow(
    {
      threadName: args.threadName,
      hasBriefConfig: args.hasBriefConfig,
      // ここに来ている時点でそのスレッドに稼働セッションは無い。
      hasSession: false,
      sessionCount: args.sessionCount,
      maxSessions: args.maxSessions,
      env: args.env,
    },
    args.threadId,
    args.deps,
  );

  if (result.ok) {
    console.log(`[brief-window] restarted (thread=${args.threadId})`);
    // 引き金の発言は中継しない: 起動直後の TUI に `/brief-window` と会長の発言を
    // 同時に打つと RW-025 / RW-047 と同じ入力取りこぼしを起こす。黙って捨てず、
    // 「もう一度送って」と明示する。
    await args.deps
      .postToThread(args.threadId, BRIEF_WINDOW_RESTART_NOTICE)
      .catch((err) =>
        console.error(
          `[brief-window] restart notice failed (thread=${args.threadId}):`,
          err,
        ),
      );
    return "restarted";
  }

  if (result.stage === "skipped") {
    // 窓口でないスレッドだけが従来経路（#456 の汎用 wake → salvage）へ戻る。
    if (result.reason === "not_window_thread") return "not_window";

    // ここから下は「窓口だが今は起こさない」。汎用 wake に落とすと素の
    // --resume が噛んで #454 の契約（/brief-window 再注入 + 再送依頼）を
    // 黙って上書きするため、理由を出したうえで消費する（#463）。
    const notice =
      result.reason === "disabled"
        ? BRIEF_WINDOW_DISABLED_NOTICE
        : result.reason === "no_brief_config"
          ? BRIEF_WINDOW_NO_CONFIG_NOTICE
          : null; // capacity は restartBriefWindow がスレッドへ通知済み
    if (notice) {
      await args.deps
        .postToThread(args.threadId, notice)
        .catch((err) =>
          console.error(
            `[brief-window] skip notice failed (thread=${args.threadId}):`,
            err,
          ),
        );
    }
    return "blocked";
  }

  // start / inject の失敗は既に post + notify 済み。二重に salvage を出さない。
  console.warn(
    `[brief-window] restart failed (thread=${args.threadId}, stage=${result.stage})`,
  );
  return "blocked";
}
