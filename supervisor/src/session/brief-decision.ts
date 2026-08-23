/**
 * 朝レポ決裁のチャンネル直下ボタン UI と、タップによる決裁確定（Issue #449）。
 *
 * #426 の「稼働中 CEO セッションへ注入して AskUserQuestion を出させる」経路は、
 * セッション不在（no_session）で決裁ジャーニーが止まる（2026-08-23 朝の実機観測）。
 * 会長決裁（案 A）により、`/brief <date>` 受信時に claude-hub 自身が:
 *
 *   1. 対象チャンネルの作業ディレクトリで proposals CLI（corp なら
 *      `npm run secretary -- proposals --json`）を実行して未決提案を取得し、
 *   2. **チャンネル直下**に提案ごとの承認/却下/保留ボタンを post し、
 *   3. 会長のタップで decide CLI（`decide-proposal <id> <decision>`）を実行する。
 *
 * セッションも LLM も介在しない決定的な経路であり、決裁の**判断**は変わらず
 * 会長のタップのみが行う（#423 の自動回答禁止と同じ線。CLI は corp 側で
 * 同一決裁の再実行が no-op になる冪等設計）。
 *
 * セキュリティ境界:
 *   - **タップの認可**: ask-components.ts と同じく `evaluateAccess`（access.json の
 *     `allowFrom`）で「押した人」を検証する。ボタンが誰にでも見えても、許可
 *     ユーザー以外の押下は decide を実行しない。
 *   - **customId は閉じたトークンのみ**: `briefdec:<proposalId>:<decision>`。
 *     proposalId は {@link PROPOSAL_ID_RE} を通過したものだけがボタンになり、
 *     decision は 3 値 enum。自由文が CLI 引数に到達する経路が無い。
 *   - **CLI は argv 配列 + shell なし**（execFile）。文字列連結の shell を通さない。
 *   - registry を持たない stateless 設計: customId が全情報を運ぶため、supervisor
 *     再起動をまたいでもボタンは機能する（ask-components の token registry が
 *     再起動で失効するのと対照的。決裁は「後から押しても正しい」冪等操作なので
 *     失効させる理由がない）。
 *
 * corp 固有のコマンドはここにハードコードしない。何を実行するかは
 * `ChannelConfig.brief`（config/channels.ts）が持ち、未設定チャンネルでは
 * この経路全体が fail-closed で動かない。
 */

import { execFile } from "child_process";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from "discord.js";
import {
  evaluateAccess,
  type AccessDecision,
  type AccessQuery,
} from "../config/access-policy";
import { safeRespond } from "../commands/safe-respond";

/** customId 名前空間。`briefdec:<proposalId>:<decision>`。 */
export const BRIEF_DECISION_PREFIX = "briefdec:";

/** corp CLI `decide-proposal` が受け付ける決裁 3 値（corp src/cli.ts）。 */
export const PROPOSAL_DECISIONS = ["approved", "rejected", "deferred"] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];

/**
 * ボタンに載せてよい提案 id の形。corp の提案 id（`dispatch-<dept>-<slug>`）を
 * 十分に覆いつつ、`:`（customId の区切り）や空白・shell メタ文字を含む id を
 * 構造的に排除する。80 文字上限は customId 全体（Discord 上限 100）に
 * `briefdec:` (9) + `:approved` (9) を足しても収まる長さ（= 98）。
 */
export const PROPOSAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** Discord の 1 メッセージあたり ActionRow 上限 = 決裁ボタンを並べられる提案数。 */
export const MAX_PROPOSALS_PER_MESSAGE = 5;

/** Discord のメッセージ本文上限は 2000。余裕を残す（ask-components と同じ値）。 */
const CONTENT_LIMIT = 1900;

/** 決裁ラベル（ボタン表示と決裁済み行の両方で使う）。 */
export const DECISION_LABELS: Record<ProposalDecision, string> = {
  approved: "承認",
  rejected: "却下",
  deferred: "保留",
};

/** proposals CLI 出力のうち、この UI が必要とする最小面。 */
export interface PendingProposal {
  id: string;
  title: string;
  priority: number | null;
  targetDept: string | null;
  pendingDays: number | null;
}

export type ParsedProposals =
  | {
      kind: "ok";
      /** CLI が報告した業務日（`/brief` の日付と異なることがある）。 */
      date: string;
      /** 提案の総数（決裁済み含む）。 */
      total: number;
      /** 未決（decision === null）のうちボタン化できたもの。 */
      pending: PendingProposal[];
      /** id が {@link PROPOSAL_ID_RE} を通らず除外した未決の件数。 */
      skipped: number;
    }
  | { kind: "error"; reason: string };

/**
 * `proposals --json` の stdout をパースする（出典: corp src/cli.ts
 * runProposalsCmd — stdout は `{ date, pending, proposals: [...] }` の JSON 1 本、
 * ログは stderr）。npm の run banner が stdout に混ざる環境に備えて最初の `{`
 * から読む。未決 = `decision === null`。id が customId に載せられない形の
 * 提案は**その 1 件だけ**除外して数を報告する（1 件の異常で朝の決裁全体を
 * 落とさない。ただし黙って落とさず skipped で数える）。
 */
export function parseProposalsOutput(stdout: string): ParsedProposals {
  const start = stdout.indexOf("{");
  if (start < 0) {
    return { kind: "error", reason: "proposals 出力に JSON がありません" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return { kind: "error", reason: "proposals 出力の JSON を解析できません" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "error", reason: "proposals 出力が object ではありません" };
  }
  const obj = parsed as Record<string, unknown>;
  const date = typeof obj.date === "string" ? obj.date : "";
  const rows = Array.isArray(obj.proposals) ? obj.proposals : null;
  if (!date || !rows) {
    return {
      kind: "error",
      reason: "proposals 出力に date / proposals がありません",
    };
  }

  const pending: PendingProposal[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.decision !== null) continue; // 決裁済みはボタン対象外
    const id = typeof r.id === "string" ? r.id : "";
    if (!PROPOSAL_ID_RE.test(id)) {
      skipped += 1;
      continue;
    }
    pending.push({
      id,
      title: typeof r.title === "string" ? r.title : id,
      priority: typeof r.priority === "number" ? r.priority : null,
      targetDept: typeof r.targetDept === "string" ? r.targetDept : null,
      pendingDays: typeof r.pendingDays === "number" ? r.pendingDays : null,
    });
  }
  return { kind: "ok", date, total: rows.length, pending, skipped };
}

export function buildBriefDecisionCustomId(
  proposalId: string,
  decision: ProposalDecision,
): string {
  return `${BRIEF_DECISION_PREFIX}${proposalId}:${decision}`;
}

/** このモジュール宛の component interaction か。 */
export function isBriefDecisionComponentId(customId: string): boolean {
  return customId.startsWith(BRIEF_DECISION_PREFIX);
}

export function parseBriefDecisionCustomId(
  customId: string,
): { proposalId: string; decision: ProposalDecision } | null {
  if (!isBriefDecisionComponentId(customId)) return null;
  const parts = customId.slice(BRIEF_DECISION_PREFIX.length).split(":");
  if (parts.length !== 2) return null;
  const [proposalId, decision] = parts as [string, string];
  if (!PROPOSAL_ID_RE.test(proposalId)) return null;
  if (!PROPOSAL_DECISIONS.includes(decision as ProposalDecision)) return null;
  return { proposalId, decision: decision as ProposalDecision };
}

export type BriefDecisionRow = ActionRowBuilder<ButtonBuilder>;

export interface BriefDecisionMessage {
  content: string;
  components: BriefDecisionRow[];
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function buildProposalRow(
  proposal: PendingProposal,
  ordinal: number,
): BriefDecisionRow {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildBriefDecisionCustomId(proposal.id, "approved"))
      .setLabel(`✅ 承認 ${ordinal}`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildBriefDecisionCustomId(proposal.id, "rejected"))
      .setLabel(`⛔ 却下 ${ordinal}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildBriefDecisionCustomId(proposal.id, "deferred"))
      .setLabel(`⏸ 保留 ${ordinal}`)
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * 未決提案の決裁メッセージ群を組み立てる。ActionRow は 1 メッセージ 5 行が
 * Discord の上限なので、6 件以上は複数メッセージに分ける（silent truncation を
 * しない — 上限で切り捨てると「表に出なかった提案が永遠に未決のまま」になる）。
 * 通し番号（ordinal）はメッセージをまたいで連番にし、本文の行とボタンの
 * ラベルが同じ番号で対応する。
 */
export function buildBriefDecisionMessages(
  date: string,
  pending: PendingProposal[],
): BriefDecisionMessage[] {
  const messages: BriefDecisionMessage[] = [];
  for (let i = 0; i < pending.length; i += MAX_PROPOSALS_PER_MESSAGE) {
    const chunk = pending.slice(i, i + MAX_PROPOSALS_PER_MESSAGE);
    const head =
      i === 0
        ? `📋 **朝レポ（${date}）の未決提案 ${pending.length} 件** — ボタンで決裁してください（承認は次の dispatch 周期で部署へ投入されます）`
        : `📋 朝レポ（${date}）未決提案のつづき`;
    const lines = chunk.map((p, j) => {
      const ordinal = i + j + 1;
      const pri = p.priority !== null ? `[D${p.priority}] ` : "";
      const dept = p.targetDept ? `**${p.targetDept}** ` : "";
      const days =
        p.pendingDays !== null && p.pendingDays > 1
          ? `（未決 ${p.pendingDays} 日目)`
          : "";
      return `${ordinal}. ${pri}${dept}${truncate(p.title, 160)}${days}\n   id: \`${p.id}\``;
    });
    messages.push({
      content: truncate([head, ...lines].join("\n"), CONTENT_LIMIT),
      components: chunk.map((p, j) => buildProposalRow(p, i + j + 1)),
    });
  }
  return messages;
}

/** 未決 0 件のときの 1 行報告（ボタンなし）。 */
export function buildAllDecidedMessage(date: string, total: number): string {
  return total > 0
    ? `✅ 朝レポ（${date}）の提案 ${total} 件はすべて決裁済みです（未決 0 件）。`
    : `ℹ️ 朝レポ（${date}）に CEO 提案はありません。`;
}

/** CLI 実行結果。`code === null` はシグナル/タイムアウトによる異常終了。 */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * CLI 実行の注入点。実体は {@link runBriefCli}、テストは fake を渡す。
 * args は argv 配列（shell を通さない）。
 */
export type BriefCliRunner = (args: string[], cwd: string) => Promise<CliResult>;

/**
 * 既定の CLI runner。`execFile`（shell なし）+ タイムアウトで、corp CLI の
 * 実行が刺さってもゲートウェイ側のハンドラが永久に待たないようにする。
 * npm 経由（`npm run secretary -- ...`）は tsx 起動込みで数秒かかるため、
 * 余裕を持って 2 分。
 */
export const runBriefCli: BriefCliRunner = (args, cwd) =>
  new Promise((resolvePromise) => {
    const [cmd, ...rest] = args;
    if (!cmd) {
      resolvePromise({ code: null, stdout: "", stderr: "empty command" });
      return;
    }
    execFile(
      cmd,
      rest,
      { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err === null
            ? 0
            : typeof (err as NodeJS.ErrnoException & { code?: unknown }).code ===
                "number"
              ? ((err as unknown as { code: number }).code ?? null)
              : null;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/**
 * `/brief` の decide verdict 後の一連（取得 → パース → post）。bot.ts から
 * Discord I/O と通知を注入して呼ぶ。ここに抽出してあるのは、失敗経路
 * （CLI 失敗 / パース失敗 / post 失敗 / skipped）の報告義務を bot.ts の
 * 配線コード（カバレッジ対象外に近い）ではなく単体テストで固定するため。
 */
export interface BriefDecideFlowInput {
  /** `/brief` が運んだ日付（表示用。CLI は常に当日の業務日を返す）。 */
  date: string;
  /** ログ用のチャンネル名。 */
  channelName: string;
  /** proposals CLI の作業ディレクトリ。 */
  cwd: string;
  /** 未決提案の取得コマンド（argv）。 */
  proposalsArgs: string[];
  runCli?: BriefCliRunner;
  /** チャンネル直下へのテキスト post（報告・警告用）。 */
  postToChannel: (text: string) => Promise<void>;
  /** 決裁ボタン付きメッセージの post。失敗は throw してよい（flow が受ける）。 */
  postDecisionMessage: (msg: BriefDecisionMessage) => Promise<void>;
  /** 取得失敗時のページング（Pushover 等）。失敗しても flow は落ちない。 */
  notifyFailure: (title: string, body: string) => Promise<void>;
}

/**
 * @returns true = 決裁 UI（または「未決なし」報告）の post まで成功し、呼び出し元が
 * 同日 dedup を記録してよい。false = 失敗（dedup を記録せず、同じ日付の再送で
 * 回復できる余地を残す — corp-brief.ts の duplicate 契約）。
 */
export async function runBriefDecideFlow(
  input: BriefDecideFlowInput,
): Promise<boolean> {
  const runCli = input.runCli ?? runBriefCli;

  // AC-3 相当（#426 から継承）: 取得失敗を silent にしない。corp は自動で
  // 再送しないので、チャンネルへの報告 + ページで同じ朝に気付けるようにする。
  const reportFetchFailure = async (detail: string): Promise<void> => {
    console.error(
      `[brief-decision] proposals fetch failed in channel ${input.channelName} (date=${input.date}): ${detail}`,
    );
    await input.postToChannel(
      `⚠️ 朝レポ（${input.date}）の未決提案を取得できませんでした（決裁は未実行）。\n` +
        `\`\`\`\n${truncate(detail, 500)}\n\`\`\``,
    );
    await input
      .notifyFailure(
        "朝レポの決裁依頼が未達",
        `#${input.channelName} で未決提案の取得に失敗し ${input.date} の朝レポ決裁を提示できませんでした。`,
      )
      .catch((err) =>
        console.warn("[brief-decision] fetch-failure notify failed:", err),
      );
  };

  const cliResult = await runCli(input.proposalsArgs, input.cwd);
  if (cliResult.code !== 0) {
    await reportFetchFailure(
      `exit ${cliResult.code ?? "signal/timeout"}: ${cliResult.stderr.trim()}`,
    );
    return false;
  }
  const proposals = parseProposalsOutput(cliResult.stdout);
  if (proposals.kind === "error") {
    await reportFetchFailure(proposals.reason);
    return false;
  }

  if (proposals.pending.length === 0 && proposals.skipped === 0) {
    await input.postToChannel(
      buildAllDecidedMessage(input.date, proposals.total),
    );
    return true;
  }

  try {
    for (const msg of buildBriefDecisionMessages(input.date, proposals.pending)) {
      await input.postDecisionMessage(msg);
    }
  } catch (err) {
    console.error(
      `[brief-decision] decision post failed in channel ${input.channelName}:`,
      err,
    );
    return false;
  }

  if (proposals.skipped > 0) {
    // id がボタン化できない提案を黙って落とさない（silent truncation 禁止）。
    console.warn(
      `[brief-decision] ${proposals.skipped} pending proposal(s) skipped (id not button-safe) in channel ${input.channelName}`,
    );
    await input.postToChannel(
      `⚠️ 未決提案のうち ${proposals.skipped} 件は id をボタン化できず表示していません。` +
        `作業ディレクトリで proposals コマンドを直接確認してください。`,
    );
  }
  return true;
}

/** 決裁ボタンが押されたチャンネルに対する実行設定（config/channels.ts 由来）。 */
export interface BriefDecisionChannelConfig {
  channelName: string;
  /** CLI の作業ディレクトリ（`ChannelConfig.dir`）。 */
  cwd: string;
  /** 決裁確定コマンド（argv）。末尾に `<proposalId> <decision>` を追加して実行。 */
  decideArgs: string[];
}

export interface BriefDecisionHandlerDeps {
  /**
   * interaction の発生チャンネルを実行設定へ解決する。`null` = このチャンネルは
   * brief 決裁の対象外（fail-closed: ボタンだけが何らかの経路で存在しても
   * 実行しない）。
   */
  resolveChannel: (
    channelId: string,
    channelName: string,
  ) => BriefDecisionChannelConfig | null;
  runCli?: BriefCliRunner;
  /** access.json gate。既定は実 policy 評価。テストで注入する。 */
  checkAccess?: (query: AccessQuery) => AccessDecision;
}

/**
 * 決裁ボタンの interaction handler。ask-components.ts の handler と同じ流儀:
 * bot.ts の dispatcher が customId prefix で振り分け、それ以降はここが持つ。
 * 応答しない失敗経路を作らない（押して無反応が最悪の UX）。
 *
 * 認可はタップした**ユーザー**に対して行う（`allowFrom`）。ask-components の
 * must-1 と同じ理屈で、テキスト返信と同じゲートをタップにも課す — これが
 * 「会長のタップのみが決裁を確定できる」の実装点。`isMention: true` は
 * ask-components と同じ意図（component interaction は常に bot 宛て）。
 *
 * 二重タップは 2 段で守る: in-flight ガード（同じ提案の実行が終わるまで後続を
 * 断る）+ corp CLI 自体の冪等性（同一決裁の再実行は no-op、変更は上書き記録）。
 */
export function createBriefDecisionHandler(deps: BriefDecisionHandlerDeps) {
  const runCli = deps.runCli ?? runBriefCli;
  const checkAccess = deps.checkAccess ?? ((query) => evaluateAccess(query));
  const inFlight = new Set<string>();

  return async (interaction: ButtonInteraction): Promise<void> => {
    const parsed = parseBriefDecisionCustomId(interaction.customId);
    if (!parsed) {
      await safeRespond(interaction, {
        content: "ℹ️ この操作は認識できませんでした。",
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.channel;
    const channelName =
      channel && "name" in channel && typeof channel.name === "string"
        ? channel.name
        : "";
    const config = deps.resolveChannel(interaction.channelId ?? "", channelName);
    if (!config) {
      console.warn(
        `[brief-decision] tap on unconfigured channel (${channelName || "unknown"}); not executed`,
      );
      await safeRespond(interaction, {
        content: "⚠️ このチャンネルには brief 決裁の実行設定がありません。",
        ephemeral: true,
      });
      return;
    }

    // 押した人の認可（ask-components must-1 の双子）。decision の内容以前に、
    // 実行可否をここで確定する。
    const userId = interaction.user?.id ?? "";
    const decision: AccessDecision = userId
      ? checkAccess({
          channelKey: interaction.channelId ?? "",
          userId,
          isMention: true,
        })
      : { allowed: false, reason: "sender_not_allowlisted" };
    if (!decision.allowed) {
      console.warn(
        `[brief-decision] tap denied (reason=${decision.reason}) in channel ${config.channelName}; not executed`,
      );
      await safeRespond(interaction, {
        content:
          "🚫 決裁する権限がありません（このチャンネルの許可リストに登録されたユーザーのみ決裁できます）。",
        ephemeral: true,
      });
      return;
    }

    const flightKey = `${config.channelName}:${parsed.proposalId}`;
    if (inFlight.has(flightKey)) {
      await safeRespond(interaction, {
        content: `⏳ ${parsed.proposalId} は処理中です。完了メッセージをお待ちください。`,
        ephemeral: true,
      });
      return;
    }
    inFlight.add(flightKey);

    try {
      // decide CLI は npm + tsx 起動で数秒かかる。Discord の 3 秒 ack 期限を
      // 超えるため先に defer する（以降は editReply が応答面になる）。
      // flags: 64 = ephemeral（compact-button.ts と同じ流儀）。
      await interaction.deferReply({ flags: 64 });

      const args = [...config.decideArgs, parsed.proposalId, parsed.decision];
      const result = await runCli(args, config.cwd);
      const label = DECISION_LABELS[parsed.decision];

      if (result.code !== 0) {
        // 失敗は会長にそのまま見せる（silent fallback 禁止）。stderr には
        // corp CLI の使い方エラー / snapshot 不在などの実因が載る。
        console.error(
          `[brief-decision] decide failed (channel=${config.channelName}, proposal=${parsed.proposalId}, decision=${parsed.decision}, code=${result.code}): ${result.stderr.trim()}`,
        );
        await interaction.editReply({
          content: `⚠️ 決裁コマンドが失敗しました（exit ${result.code ?? "signal/timeout"}）。\n\`\`\`\n${truncate(result.stderr.trim() || result.stdout.trim() || "(出力なし)", 500)}\n\`\`\``,
        });
        return;
      }

      // corp CLI は同一決裁の再実行を no-op として stderr に「既に ... 済み」を
      // 出す（exit 0）。成功として扱いつつ、その旨は会長に伝える。
      const noop = result.stderr.includes("既に");
      console.log(
        `[brief-decision] decided (channel=${config.channelName}, proposal=${parsed.proposalId}, decision=${parsed.decision}${noop ? ", no-op" : ""})`,
      );
      await interaction.editReply({
        content: noop
          ? `ℹ️ ${parsed.proposalId} は既に ${label} 済みでした（変更なし）。`
          : `✅ ${parsed.proposalId} を **${label}** として確定しました。${
              parsed.decision === "approved"
                ? "次の dispatch 周期で部署へ投入されます。"
                : ""
            }`,
      });

      await markRowDecided(interaction, parsed.proposalId, parsed.decision);
    } finally {
      inFlight.delete(flightKey);
    }
  };
}

/**
 * 決裁済みの提案の行（ボタン 3 つ）を disable し、本文に決裁結果を追記する。
 * best-effort: 決裁自体は既に確定しているので、メッセージ更新の失敗は log のみ
 * （ask-components の disableStaleMessage と同じ扱い）。
 *
 * stateless 設計のため元の提案リストを持っていない。行の特定は「その行の
 * ボタンの customId が同じ proposalId を指すか」で行い、対象行だけ disabled で
 * 再構築、他の行は現状のまま `ActionRowBuilder.from` で写す。
 */
async function markRowDecided(
  interaction: ButtonInteraction,
  proposalId: string,
  decision: ProposalDecision,
): Promise<void> {
  try {
    const message = interaction.message;
    if (!message) return;
    const rows = message.components.map((row) => {
      const builder = ActionRowBuilder.from(
        row as never,
      ) as ActionRowBuilder<ButtonBuilder>;
      const belongs = builder.components.some((c) => {
        const id = (c.data as { custom_id?: string }).custom_id ?? "";
        return parseBriefDecisionCustomId(id)?.proposalId === proposalId;
      });
      if (belongs) {
        for (const c of builder.components) c.setDisabled(true);
      }
      return builder;
    });
    const stamp = `✅ \`${proposalId}\`: ${DECISION_LABELS[decision]}（会長決裁）`;
    const base = message.content ?? "";
    const budget = CONTENT_LIMIT - stamp.length - 2;
    const content = `${base.length > budget ? truncate(base, budget) : base}\n\n${stamp}`;
    await message.edit({ content, components: rows });
  } catch (err) {
    console.warn(
      `[brief-decision] decided but message update failed (proposal=${proposalId}):`,
      err,
    );
  }
}
