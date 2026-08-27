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
  type BriefProposal,
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

function proposal(over: Partial<BriefProposal> = {}): BriefProposal {
  return {
    id: "dispatch-social-436",
    title: "[social] 着手検討: #436",
    priority: 3,
    targetDept: "social",
    pendingDays: 1,
    decision: null,
    ...over,
  };
}

/** corp CLI `proposals --json` 相当の stdout を組み立てる。 */
function proposalsJson(rows: unknown[]): string {
  return JSON.stringify({ date: "2026-08-23", pending: { count: 1, maxDays: 1 }, proposals: rows });
}

describe("parseProposalsOutput", () => {
  test("keeps decided proposals too, and counts the pending ones (#132)", () => {
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
      expect(out.proposals.map((p: BriefProposal) => p.id)).toEqual(["a-1", "b-2"]);
      expect(out.proposals.map((p: BriefProposal) => p.decision)).toEqual([null, "approved"]);
      expect(out.pendingCount).toBe(1);
      expect(out.skipped).toBe(0);
    }
  });

  test("tolerates an npm run banner before the JSON (reads from the first brace)", () => {
    const out = parseProposalsOutput(`> secretary\n> tsx src/cli.ts proposals --json\n${proposalsJson([])}`);
    expect(out.kind).toBe("ok");
  });

  test("skips (and counts) a proposal whose id cannot ride a customId", () => {
    const out = parseProposalsOutput(
      proposalsJson([
        { id: "ok-id", title: "OK", decision: null },
        { id: "bad id with spaces", title: "NG", decision: null },
        { id: "colon:id", title: "NG", decision: null },
      ]),
    );
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.proposals.map((p: BriefProposal) => p.id)).toEqual(["ok-id"]);
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

// ---------------------------------------------------------------------------
// runBriefDecideFlow（bot.ts の decide case から抽出された一連）
// ---------------------------------------------------------------------------

import { runBriefDecideFlow } from "../../src/session/brief-decision";

interface FlowCapture {
  channelPosts: string[];
  decisionPosts: number;
  notifications: string[];
}

function flowDeps(
  cli: CliResult,
  over: {
    postDecisionMessage?: () => Promise<void>;
  } = {},
): { capture: FlowCapture; input: Parameters<typeof runBriefDecideFlow>[0] } {
  const capture: FlowCapture = { channelPosts: [], decisionPosts: 0, notifications: [] };
  return {
    capture,
    input: {
      date: "2026-08-23",
      channelName: "corp",
      cwd: "/tmp/corp",
      proposalsArgs: ["npm", "run", "secretary", "--", "proposals", "--json"],
      runCli: async () => cli,
      postToChannel: async (text) => {
        capture.channelPosts.push(text);
      },
      postDecisionMessage:
        over.postDecisionMessage ??
        (async () => {
          capture.decisionPosts += 1;
        }),
      notifyFailure: async (title) => {
        capture.notifications.push(title);
      },
    },
  };
}

describe("runBriefDecideFlow", () => {
  test("pending ありなら決裁メッセージを post して true（dedup 記録可）", async () => {
    const { capture, input } = flowDeps({
      code: 0,
      stdout: proposalsJson([{ id: "a-1", title: "A", decision: null }]),
      stderr: "",
    });
    await expect(runBriefDecideFlow(input)).resolves.toBe(true);
    expect(capture.decisionPosts).toBe(1);
    expect(capture.notifications.length).toBe(0);
  });

  test("未決 0 件でも決裁済みがあればボタンを出す（押し直せる・#132）", async () => {
    const { capture, input } = flowDeps({
      code: 0,
      stdout: proposalsJson([{ id: "a-1", title: "A", decision: "approved" }]),
      stderr: "",
    });
    await expect(runBriefDecideFlow(input)).resolves.toBe(true);
    expect(capture.decisionPosts).toBe(1);
    expect(capture.channelPosts.join("\n")).not.toContain("すべて決裁済み");
  });

  test("提案が 1 件も無ければ「すべて決裁済み」1 行のみで true", async () => {
    const { capture, input } = flowDeps({
      code: 0,
      stdout: proposalsJson([]),
      stderr: "",
    });
    await expect(runBriefDecideFlow(input)).resolves.toBe(true);
    expect(capture.decisionPosts).toBe(0);
    expect(capture.channelPosts.join("\n")).toContain("提案はありません");
  });

  test("CLI 失敗はチャンネル報告 + ページで false（silent にしない・dedup 記録不可）", async () => {
    const { capture, input } = flowDeps({
      code: 1,
      stdout: "",
      stderr: "当日の snapshot がありません",
    });
    await expect(runBriefDecideFlow(input)).resolves.toBe(false);
    expect(capture.channelPosts.join("\n")).toContain("取得できませんでした");
    expect(capture.channelPosts.join("\n")).toContain("snapshot");
    expect(capture.notifications).toEqual(["朝レポの決裁依頼が未達"]);
  });

  test("パース不能な出力も同じ失敗報告で false", async () => {
    const { capture, input } = flowDeps({ code: 0, stdout: "not json", stderr: "" });
    await expect(runBriefDecideFlow(input)).resolves.toBe(false);
    expect(capture.notifications.length).toBe(1);
  });

  test("決裁メッセージの post 失敗は false（同日再送で回復できる余地を残す）", async () => {
    const { input } = flowDeps(
      {
        code: 0,
        stdout: proposalsJson([{ id: "a-1", title: "A", decision: null }]),
        stderr: "",
      },
      {
        postDecisionMessage: async () => {
          throw new Error("50013 Missing Permissions");
        },
      },
    );
    await expect(runBriefDecideFlow(input)).resolves.toBe(false);
  });

  test("ボタン化できない id は skipped として警告される（silent truncation 禁止）", async () => {
    const { capture, input } = flowDeps({
      code: 0,
      stdout: proposalsJson([
        { id: "a-1", title: "A", decision: null },
        { id: "bad id", title: "B", decision: null },
      ]),
      stderr: "",
    });
    await expect(runBriefDecideFlow(input)).resolves.toBe(true);
    expect(capture.decisionPosts).toBe(1);
    expect(capture.channelPosts.join("\n")).toContain("1 件は id または決裁値をボタン化できず");
  });

  test("notify 自体の失敗で flow は落ちない", async () => {
    const { input } = flowDeps({ code: 1, stdout: "", stderr: "boom" });
    input.notifyFailure = async () => {
      throw new Error("pushover down");
    };
    await expect(runBriefDecideFlow(input)).resolves.toBe(false);
  });
});

/**
 * Issue #132: 朝レポに提案が 4 件並んでも押せるのは未決 1 件だけ、という状態の修正。
 * 決裁済みもボタン化し、現在の決裁ボタンだけ disabled にして押し直しを通す。
 */
describe("決裁済み提案の押し直し（#132）", () => {
  test("未知の決裁値は null に倒さず skipped に数える（嘘の未決を作らない）", () => {
    const out = parseProposalsOutput(
      proposalsJson([
        { id: "ok-1", title: "OK", decision: null },
        { id: "weird-1", title: "NG", decision: "escalated" },
      ]),
    );
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.proposals.map((p: BriefProposal) => p.id)).toEqual(["ok-1"]);
      expect(out.skipped).toBe(1);
    }
  });

  test("未決の行は 3 ボタンとも押せる", () => {
    const [msg] = buildBriefDecisionMessages("2026-08-25", [proposal()]);
    const row = msg!.components[0]!.toJSON();
    expect(row.components.map((c) => (c as { disabled?: boolean }).disabled ?? false)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("決裁済みの行は現在の決裁だけ disabled、他の 2 つは押せる", () => {
    const [msg] = buildBriefDecisionMessages("2026-08-25", [
      proposal({ decision: "rejected" }),
    ]);
    const row = msg!.components[0]!.toJSON();
    const byId = row.components.map((c) => {
      const b = c as { custom_id?: string; disabled?: boolean };
      return [parseBriefDecisionCustomId(b.custom_id ?? "")?.decision, b.disabled ?? false];
    });
    expect(byId).toEqual([
      ["approved", false],
      ["rejected", true],
      ["deferred", false],
    ]);
  });

  test("決裁済みを含む全提案が行として並ぶ（未決だけに絞らない）", () => {
    const msgs = buildBriefDecisionMessages("2026-08-25", [
      proposal({ id: "p-1", decision: "approved" }),
      proposal({ id: "p-2", decision: "rejected" }),
      proposal({ id: "p-3", decision: null }),
      proposal({ id: "p-4", decision: "approved" }),
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.components).toHaveLength(4);
  });

  test("見出しは総数と未決数の両方を出す", () => {
    const [msg] = buildBriefDecisionMessages("2026-08-25", [
      proposal({ id: "p-1", decision: "approved" }),
      proposal({ id: "p-2", decision: null }),
    ]);
    expect(msg!.content).toContain("提案 2 件");
    expect(msg!.content).toContain("未決 1 件");
  });

  test("決裁済みの行には現在の決裁が本文に出る", () => {
    const [msg] = buildBriefDecisionMessages("2026-08-25", [
      proposal({ decision: "rejected" }),
    ]);
    expect(msg!.content).toContain("現在: 却下");
  });

  test("5 件超は複数メッセージに分かれ、通し番号が連番になる（決裁済み込み）", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      proposal({ id: `p-${i + 1}`, decision: i % 2 === 0 ? "approved" : null }),
    );
    const msgs = buildBriefDecisionMessages("2026-08-25", rows);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.components).toHaveLength(MAX_PROPOSALS_PER_MESSAGE);
    expect(msgs[1]!.components).toHaveLength(7 - MAX_PROPOSALS_PER_MESSAGE);
    expect(msgs[1]!.content).toContain("6. ");
    expect(msgs[1]!.content).toContain("7. ");
  });
});
