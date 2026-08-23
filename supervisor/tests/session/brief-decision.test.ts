import { describe, test, expect } from "bun:test";
import type { ButtonInteraction } from "discord.js";
import {
  BRIEF_DECISION_PREFIX,
  MAX_PROPOSALS_PER_MESSAGE,
  buildAllDecidedMessage,
  buildBriefDecisionCustomId,
  buildBriefDecisionMessages,
  createBriefDecisionHandler,
  isBriefDecisionComponentId,
  parseBriefDecisionCustomId,
  parseProposalsOutput,
  type CliResult,
  type PendingProposal,
} from "../../src/session/brief-decision";

/**
 * Issue #449: `/brief` のタップ決裁。セッションを介さず、supervisor が
 * proposals CLI の出力からチャンネル直下の決裁ボタンを組み立て、会長のタップで
 * decide CLI を実行する。テストが固定する性質:
 *
 *   1. customId は閉じたトークンのみ（提案 id の形を通過したものだけがボタンになる）
 *   2. タップの認可は access.json ゲートを通る（deny なら CLI は実行されない）
 *   3. 未決 6 件以上は複数メッセージに分かれ、silent truncation しない
 *   4. CLI 失敗は会長へ報告される（silent fallback 禁止）
 */

function proposal(over: Partial<PendingProposal> = {}): PendingProposal {
  return {
    id: "dispatch-social-436",
    title: "[social] 着手検討: #436",
    priority: 3,
    targetDept: "social",
    pendingDays: 1,
    ...over,
  };
}

/** corp CLI `proposals --json` 相当の stdout を組み立てる。 */
function proposalsJson(rows: unknown[]): string {
  return JSON.stringify({ date: "2026-08-23", pending: { count: 1, maxDays: 1 }, proposals: rows });
}

describe("parseProposalsOutput", () => {
  test("parses pending proposals and drops decided ones", () => {
    const out = parseProposalsOutput(
      proposalsJson([
        { id: "a-1", title: "A", priority: 1, targetDept: "x", decision: null, pendingDays: 2 },
        { id: "b-2", title: "B", priority: 2, targetDept: "y", decision: "approved", pendingDays: null },
      ]),
    );
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.date).toBe("2026-08-23");
      expect(out.total).toBe(2);
      expect(out.pending.map((p) => p.id)).toEqual(["a-1"]);
      expect(out.skipped).toBe(0);
    }
  });

  test("tolerates an npm run banner before the JSON (reads from the first brace)", () => {
    const out = parseProposalsOutput(`> secretary\n> tsx src/cli.ts proposals --json\n${proposalsJson([])}`);
    expect(out.kind).toBe("ok");
  });

  test("skips (and counts) a pending proposal whose id cannot ride a customId", () => {
    const out = parseProposalsOutput(
      proposalsJson([
        { id: "ok-id", title: "OK", decision: null },
        { id: "bad id with spaces", title: "NG", decision: null },
        { id: "colon:id", title: "NG", decision: null },
      ]),
    );
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.pending.map((p) => p.id)).toEqual(["ok-id"]);
      expect(out.skipped).toBe(2);
    }
  });

  test("errors on output without JSON / with broken JSON / without proposals", () => {
    expect(parseProposalsOutput("no json here").kind).toBe("error");
    expect(parseProposalsOutput("{broken").kind).toBe("error");
    expect(parseProposalsOutput(JSON.stringify({ date: "2026-08-23" })).kind).toBe("error");
    expect(parseProposalsOutput(JSON.stringify({ proposals: [] })).kind).toBe("error");
  });
});

describe("customId scheme", () => {
  test("builds and parses a round trip", () => {
    const id = buildBriefDecisionCustomId("dispatch-social-436", "approved");
    expect(isBriefDecisionComponentId(id)).toBe(true);
    expect(parseBriefDecisionCustomId(id)).toEqual({
      proposalId: "dispatch-social-436",
      decision: "approved",
    });
  });

  test("stays within Discord's 100-char customId limit at the max id length", () => {
    const longId = `a${"b".repeat(79)}`; // PROPOSAL_ID_RE の上限 80 文字
    const customId = buildBriefDecisionCustomId(longId, "approved");
    expect(customId.length).toBeLessThanOrEqual(100);
    expect(parseBriefDecisionCustomId(customId)?.proposalId).toBe(longId);
  });

  test("rejects foreign prefixes, unknown decisions, and malformed ids", () => {
    expect(parseBriefDecisionCustomId("ask:tok:1")).toBeNull();
    expect(parseBriefDecisionCustomId(`${BRIEF_DECISION_PREFIX}id-1:destroy`)).toBeNull();
    expect(parseBriefDecisionCustomId(`${BRIEF_DECISION_PREFIX}id-1`)).toBeNull();
    expect(parseBriefDecisionCustomId(`${BRIEF_DECISION_PREFIX}:approved`)).toBeNull();
    expect(parseBriefDecisionCustomId(`${BRIEF_DECISION_PREFIX}a:b:approved`)).toBeNull();
  });
});

describe("buildBriefDecisionMessages", () => {
  test("one message with one row of 3 buttons per proposal", () => {
    const msgs = buildBriefDecisionMessages("2026-08-23", [proposal()]);
    expect(msgs.length).toBe(1);
    const msg = msgs[0]!;
    expect(msg.content).toContain("2026-08-23");
    expect(msg.content).toContain("dispatch-social-436");
    expect(msg.components.length).toBe(1);
    const ids = msg.components[0]!.components.map(
      (c) => (c.data as { custom_id?: string }).custom_id,
    );
    expect(ids).toEqual([
      `${BRIEF_DECISION_PREFIX}dispatch-social-436:approved`,
      `${BRIEF_DECISION_PREFIX}dispatch-social-436:rejected`,
      `${BRIEF_DECISION_PREFIX}dispatch-social-436:deferred`,
    ]);
  });

  test("splits 7 proposals across 2 messages with continuous ordinals (no silent truncation)", () => {
    const pending = Array.from({ length: 7 }, (_, i) =>
      proposal({ id: `p-${i + 1}`, title: `提案 ${i + 1}` }),
    );
    const msgs = buildBriefDecisionMessages("2026-08-23", pending);
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.components.length).toBe(MAX_PROPOSALS_PER_MESSAGE);
    expect(msgs[1]!.components.length).toBe(2);
    // 通し番号: 2 通目は 6. から始まる
    expect(msgs[1]!.content).toContain("6. ");
    expect(msgs[1]!.content).toContain("p-6");
  });

  test("all-decided / no-proposal one-liners", () => {
    expect(buildAllDecidedMessage("2026-08-23", 4)).toContain("すべて決裁済み");
    expect(buildAllDecidedMessage("2026-08-23", 0)).toContain("提案はありません");
  });
});

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

interface FakeInteraction {
  customId: string;
  channelId: string;
  channel: { name: string; isThread: () => boolean };
  user: { id: string };
  deferred: boolean;
  replied: boolean;
  replies: unknown[];
  edits: unknown[];
  message: {
    content: string;
    components: unknown[];
    edits: unknown[];
    edit: (opts: unknown) => Promise<void>;
  };
  reply: (opts: unknown) => Promise<void>;
  deferReply: (opts?: unknown) => Promise<void>;
  editReply: (opts: unknown) => Promise<void>;
}

function fakeInteraction(over: Partial<FakeInteraction> = {}): FakeInteraction {
  const it: FakeInteraction = {
    customId: buildBriefDecisionCustomId("dispatch-social-436", "approved"),
    channelId: "999",
    channel: { name: "corp", isThread: () => false },
    user: { id: "chairman" },
    deferred: false,
    replied: false,
    replies: [],
    edits: [],
    message: {
      content: "📋 未決提案",
      components: [],
      edits: [],
      async edit(opts: unknown) {
        this.edits.push(opts);
      },
    },
    async reply(opts: unknown) {
      this.replied = true;
      this.replies.push(opts);
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(opts: unknown) {
      this.edits.push(opts);
    },
    ...over,
  };
  return it;
}

function asButton(it: FakeInteraction): ButtonInteraction {
  return it as unknown as ButtonInteraction;
}

const CORP_CHANNEL = {
  channelName: "corp",
  cwd: "/tmp/corp",
  decideArgs: ["npm", "run", "secretary", "--", "decide-proposal"],
};

function okCli(calls: string[][]): (args: string[], cwd: string) => Promise<CliResult> {
  return async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("createBriefDecisionHandler", () => {
  test("runs the decide CLI with proposalId + decision appended (allowed tap)", async () => {
    const calls: string[][] = [];
    const handler = createBriefDecisionHandler({
      resolveChannel: () => CORP_CHANNEL,
      runCli: okCli(calls),
      checkAccess: () => ({ allowed: true, reason: "allowed" }),
    });
    const it = fakeInteraction();
    await handler(asButton(it));
    expect(calls).toEqual([
      ["npm", "run", "secretary", "--", "decide-proposal", "dispatch-social-436", "approved"],
    ]);
    expect(it.deferred).toBe(true);
    expect(JSON.stringify(it.edits)).toContain("承認");
    // 決裁済み表示への message 更新も走る
    expect(it.message.edits.length).toBe(1);
    expect(JSON.stringify(it.message.edits[0])).toContain("dispatch-social-436");
  });

  test("denied tap never reaches the CLI (access gate)", async () => {
    const calls: string[][] = [];
    const handler = createBriefDecisionHandler({
      resolveChannel: () => CORP_CHANNEL,
      runCli: okCli(calls),
      checkAccess: () => ({ allowed: false, reason: "sender_not_allowlisted" }),
    });
    const it = fakeInteraction();
    await handler(asButton(it));
    expect(calls.length).toBe(0);
    expect(it.deferred).toBe(false);
    expect(JSON.stringify(it.replies)).toContain("権限がありません");
  });

  test("unconfigured channel is fail-closed (no CLI, explicit reply)", async () => {
    const calls: string[][] = [];
    const handler = createBriefDecisionHandler({
      resolveChannel: () => null,
      runCli: okCli(calls),
      checkAccess: () => ({ allowed: true, reason: "allowed" }),
    });
    const it = fakeInteraction();
    await handler(asButton(it));
    expect(calls.length).toBe(0);
    expect(JSON.stringify(it.replies)).toContain("実行設定がありません");
  });

  test("a foreign customId is answered, not executed", async () => {
    const calls: string[][] = [];
    const handler = createBriefDecisionHandler({
      resolveChannel: () => CORP_CHANNEL,
      runCli: okCli(calls),
      checkAccess: () => ({ allowed: true, reason: "allowed" }),
    });
    const it = fakeInteraction({ customId: "briefdec:not enough" });
    await handler(asButton(it));
    expect(calls.length).toBe(0);
    expect(JSON.stringify(it.replies)).toContain("認識できません");
  });

  test("CLI failure is reported to the chairman (never silent)", async () => {
    const handler = createBriefDecisionHandler({
      resolveChannel: () => CORP_CHANNEL,
      runCli: async () => ({ code: 1, stdout: "", stderr: "当日の snapshot がありません" }),
      checkAccess: () => ({ allowed: true, reason: "allowed" }),
    });
    const it = fakeInteraction();
    await handler(asButton(it));
    const edits = JSON.stringify(it.edits);
    expect(edits).toContain("失敗");
    expect(edits).toContain("snapshot");
    // 失敗時は決裁済み表示にしない
    expect(it.message.edits.length).toBe(0);
  });

  test("an already-decided no-op (corp CLI exit 0 + 既に…済み) is reported as unchanged", async () => {
    const handler = createBriefDecisionHandler({
      resolveChannel: () => CORP_CHANNEL,
      runCli: async () => ({
        code: 0,
        stdout: "",
        stderr: "既に approved 済みです: dispatch-social-436 — 変更なし",
      }),
      checkAccess: () => ({ allowed: true, reason: "allowed" }),
    });
    const it = fakeInteraction();
    await handler(asButton(it));
    expect(JSON.stringify(it.edits)).toContain("既に");
  });

  test("a double tap while the first is in flight is refused (in-flight guard)", async () => {
    let release: (r: CliResult) => void = () => {};
    const gate = new Promise<CliResult>((res) => {
      release = res;
    });
    const calls: string[][] = [];
    const handler = createBriefDecisionHandler({
      resolveChannel: () => CORP_CHANNEL,
      runCli: async (args) => {
        calls.push(args);
        return gate;
      },
      checkAccess: () => ({ allowed: true, reason: "allowed" }),
    });
    const first = fakeInteraction();
    const second = fakeInteraction();
    const p1 = handler(asButton(first));
    // 1 タップ目が CLI 待ちの間に同じ提案をもう一度タップ
    await handler(asButton(second));
    expect(JSON.stringify(second.replies)).toContain("処理中");
    expect(calls.length).toBe(1);
    release({ code: 0, stdout: "", stderr: "" });
    await p1;
    // 完了後は再びタップできる（corp CLI 側の冪等 no-op が受け止める）
    const third = fakeInteraction();
    await handler(asButton(third));
    expect(calls.length).toBe(2);
  });
});
