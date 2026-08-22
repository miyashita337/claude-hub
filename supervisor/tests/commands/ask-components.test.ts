import { test, expect, describe, spyOn } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type {
  AccessDecision,
  AccessQuery,
} from "../../src/config/access-policy";
import {
  ASK_COMPONENT_PREFIX,
  AskPromptRegistry,
  BUTTON_LABEL_LIMIT,
  CUSTOM_ID_LIMIT,
  MAX_ASK_QUESTIONS_PER_MESSAGE,
  MAX_BUTTON_OPTIONS,
  MAX_SELECT_OPTIONS,
  OPTION_SEPARATOR,
  SELECT_DESCRIPTION_LIMIT,
  buildAskChannelNotice,
  buildAskPrompt,
  buildMultiAskPrompt,
  createAskComponentHandler,
  hasActiveMultiAsk,
  isAskComponentId,
  parseAskCustomId,
  postAskChannelNotice,
  postAskUserPrompt,
  postMultiAskUserPrompt,
  shouldUseButtons,
  splitOption,
  type AskComponentKind,
  type AskPostChannel,
} from "../../src/commands/ask-components";

/**
 * Tap-to-answer components for AskUserQuestion (Issue #412).
 *
 * Mirrors compact-button.test.ts: minimal fake interactions drive the real
 * handler with no Discord gateway. Two properties matter most here — the
 * hybrid branch is decided by option count / multiSelect alone (no heuristic),
 * and no click can ever answer twice or answer a question that is already gone.
 */

// --- fakes -----------------------------------------------------------------

interface ReplyRecord {
  kind: "reply" | "update" | "messageEdit";
  content?: string;
  flags?: number;
  components?: unknown[];
}

function makeInteraction(opts: {
  customId: string;
  /** Present → a String Select interaction; absent → a button. */
  values?: string[];
  channelId?: string;
  parentId?: string;
  userId?: string;
  messageContent?: string;
  updateThrows?: boolean;
  editThrows?: boolean;
}) {
  const replies: ReplyRecord[] = [];
  const isSelect = opts.values !== undefined;
  const channelId = opts.channelId ?? "thread-1";

  const interaction = {
    customId: opts.customId,
    values: opts.values ?? [],
    channelId,
    channel: {
      id: channelId,
      isThread: () => true,
      parentId: opts.parentId ?? "parent-1",
    },
    user: { id: opts.userId ?? "user-owner" },
    deferred: false,
    replied: false,
    isStringSelectMenu: () => isSelect,
    message: {
      content: opts.messageContent ?? "❓ **Claude からの質問**\n方針は？",
      async edit(payload: { components?: unknown[] }) {
        if (opts.editThrows) throw new Error("message gone");
        replies.push({ kind: "messageEdit", components: payload.components });
      },
    },
    async reply(msg: { content?: string; flags?: number }) {
      this.replied = true;
      replies.push({ kind: "reply", content: msg.content, flags: msg.flags });
    },
    async editReply(msg: { content?: string }) {
      replies.push({ kind: "reply", content: msg.content });
    },
    async update(msg: { content?: string; components?: unknown[] }) {
      if (opts.updateThrows) throw new Error("unknown message");
      this.replied = true;
      replies.push({
        kind: "update",
        content: msg.content,
        components: msg.components,
      });
    },
  };

  return { interaction, replies };
}

function makeHandler(opts: {
  pending?: boolean;
  registry: AskPromptRegistry;
  /** Access gate verdict. Default: allow (the owner clicking their own thread). */
  access?: AccessDecision;
}) {
  const resolved: { threadId: string; answer: string }[] = [];
  const accessQueries: AccessQuery[] = [];
  const handler = createAskComponentHandler({
    hasPendingAsk: () => opts.pending ?? true,
    resolveAskUser: (threadId, answer) => {
      resolved.push({ threadId, answer });
    },
    registry: opts.registry,
    checkAccess: (query) => {
      accessQueries.push(query);
      return opts.access ?? { allowed: true, reason: "allowed" };
    },
  });
  return { handler, resolved, accessQueries };
}

/** Read the customIds out of a built row, in order. */
function customIds(row: unknown): string[] {
  const json = (row as { toJSON: () => { components: unknown[] } }).toJSON();
  return json.components.map(
    (c) => (c as { custom_id?: string }).custom_id ?? ""
  );
}

function rowJson(row: unknown) {
  return (row as { toJSON: () => Record<string, unknown> }).toJSON() as {
    components: Record<string, unknown>[];
  };
}

// --- hybrid branch ---------------------------------------------------------

describe("hybrid layout branch (#412)", () => {
  test("buttons up to the row limit, select at the boundary+1 or when multi-select", () => {
    // The branch must be decided by these two inputs alone — a heuristic here
    // is what the "決定的にすること" constraint on the issue rules out.
    for (let n = 1; n <= MAX_BUTTON_OPTIONS; n++) {
      expect(shouldUseButtons(n, false)).toBe(true);
    }
    expect(shouldUseButtons(MAX_BUTTON_OPTIONS + 1, false)).toBe(false);
    // multiSelect can't be expressed by buttons at any size, not even 1 option.
    expect(shouldUseButtons(1, true)).toBe(false);
    expect(shouldUseButtons(MAX_BUTTON_OPTIONS, true)).toBe(false);
  });

  test("5 options build one button row with app-scoped customIds", () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      {
        threadId: "thread-1",
        question: "方針は？",
        options: ["A", "B", "C", "D", "E"],
      },
      registry
    );

    expect(prompt.kind).toBe("buttons");
    expect(prompt.components).toHaveLength(1);
    const ids = customIds(prompt.components[0]);
    expect(ids).toHaveLength(5);
    ids.forEach((id, i) => {
      expect(id).toBe(`${ASK_COMPONENT_PREFIX}${prompt.token}:${i}`);
      // Discord rejects a custom_id over 100 chars; the token keeps us far
      // under it regardless of how long the option text is.
      expect(id.length).toBeLessThanOrEqual(CUSTOM_ID_LIMIT);
    });
  });

  test("6 options fall back to a select carrying every option", () => {
    const registry = new AskPromptRegistry();
    const options = ["A", "B", "C", "D", "E", "F"];
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options },
      registry
    );

    expect(prompt.kind).toBe("select");
    const menu = rowJson(prompt.components[0]).components[0] as {
      options: { value: string; label: string }[];
      max_values?: number;
      min_values?: number;
    };
    // No option may be dropped in the fallback — that is the whole point of
    // falling back rather than posting the first 5.
    expect(menu.options.map((o) => o.label)).toEqual(options);
    expect(menu.options.map((o) => o.value)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(menu.min_values).toBe(1);
    expect(menu.max_values).toBe(1);
  });

  test("multiSelect uses a select even below the button limit, with max_values = option count", () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      {
        threadId: "thread-1",
        question: "どれを含める？",
        options: ["A", "B", "C"],
        multiSelect: true,
      },
      registry
    );

    expect(prompt.kind).toBe("select");
    const menu = rowJson(prompt.components[0]).components[0] as {
      min_values?: number;
      max_values?: number;
    };
    expect(menu.min_values).toBe(1);
    expect(menu.max_values).toBe(3);
  });

  test("every layout states the real wait budget and the no-auto-select line (#416 / #423)", () => {
    const registry = new AskPromptRegistry();
    const fiveHours = 5 * 60 * 60 * 1000;
    const cases: { options?: string[]; kind: AskComponentKind }[] = [
      { kind: "text" },
      { options: ["A", "B"], kind: "buttons" },
      { options: ["A", "B", "C", "D", "E", "F"], kind: "select" },
    ];

    for (const { options, kind } of cases) {
      const prompt = buildAskPrompt(
        {
          threadId: "thread-1",
          question: "方針は？",
          ...(options ? { options } : {}),
          timeoutMs: fiveHours,
        },
        registry
      );
      expect(prompt.kind).toBe(kind);
      // The stated deadline is #416's whole point. A future merge that drops it
      // (or pins a hardcoded duration again) fails here.
      expect(prompt.content).toContain("約 5 時間");
      // #423: the owner must be able to see that nothing is auto-selected.
      expect(prompt.content).toContain("自動で選ばれることはありません");
      // Quoted from the relay's notice exactly once — the footers must not
      // restate the text-reply sentence next to it.
      const restated = prompt.content.split(
        "このスレッドへの次の返信がそのまま回答として送られます"
      ).length;
      expect(restated).toBe(2);
    }
  });

  test("no options (multi-question ask): text only, reply path unchanged", () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "Q1\nQ2" },
      registry
    );

    expect(prompt.kind).toBe("text");
    expect(prompt.components).toHaveLength(0);
    expect(prompt.content).toContain("次の返信がそのまま回答として送られます");
    expect(registry.size()).toBe(0);
  });

  test("over the select ceiling: says so and keeps every option visible (no silent truncation)", () => {
    const registry = new AskPromptRegistry();
    const options = Array.from(
      { length: MAX_SELECT_OPTIONS + 1 },
      (_, i) => `選択肢${i + 1}`
    );
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options },
      registry
    );

    expect(prompt.kind).toBe("text");
    expect(prompt.components).toHaveLength(0);
    // A truncated component list would let the user answer a question they were
    // never shown all of — the message must state the limit instead.
    expect(prompt.content).toContain(String(options.length));
    expect(prompt.content).toContain(String(MAX_SELECT_OPTIONS));
    expect(prompt.content).toContain(options[options.length - 1]!);
  });
});

// --- option text handling --------------------------------------------------

describe("option text (#412)", () => {
  test("splitOption recovers label / description from the hook's flattened form", () => {
    expect(splitOption(`案A${OPTION_SEPARATOR}既定を維持する`)).toEqual({
      label: "案A",
      description: "既定を維持する",
    });
    expect(splitOption("案A")).toEqual({ label: "案A" });
    // Only the FIRST separator splits: a description containing one stays whole.
    expect(
      splitOption(`案A${OPTION_SEPARATOR}前半${OPTION_SEPARATOR}後半`)
    ).toEqual({ label: "案A", description: `前半${OPTION_SEPARATOR}後半` });
  });

  test("select entries carry the description, truncated to the API limit", () => {
    const registry = new AskPromptRegistry();
    const long = "説".repeat(300);
    const prompt = buildAskPrompt(
      {
        threadId: "thread-1",
        question: "方針は？",
        options: Array.from(
          { length: 6 },
          (_, i) => `案${i}${OPTION_SEPARATOR}${long}`
        ),
      },
      registry
    );

    const menu = rowJson(prompt.components[0]).components[0] as {
      options: { label: string; description?: string }[];
    };
    expect(menu.options[0]?.label).toBe("案0");
    expect(menu.options[0]?.description?.length).toBeLessThanOrEqual(
      SELECT_DESCRIPTION_LIMIT
    );
  });

  test("a long label is truncated for display but answered in full", async () => {
    const registry = new AskPromptRegistry();
    const longLabel = "長".repeat(200);
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: [longLabel] },
      registry
    );
    const button = rowJson(prompt.components[0]).components[0] as {
      label: string;
    };
    expect(button.label.length).toBeLessThanOrEqual(BUTTON_LABEL_LIMIT);

    const { handler, resolved } = makeHandler({ registry });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
    });
    await handler(interaction as never);

    // Truncation is a display concern; Claude must receive the real choice.
    expect(resolved).toEqual([{ threadId: "thread-1", answer: longLabel }]);
  });
});

// --- customId parsing ------------------------------------------------------

describe("customId parsing (#412)", () => {
  test("button ids carry an index, select ids do not", () => {
    expect(parseAskCustomId(`${ASK_COMPONENT_PREFIX}abc1:2`)).toEqual({
      token: "abc1",
      index: 2,
    });
    expect(parseAskCustomId(`${ASK_COMPONENT_PREFIX}abc1`)).toEqual({
      token: "abc1",
    });
  });

  test("foreign and malformed ids are rejected, never guessed at", () => {
    // The compact button (#364) shares the dispatcher — it must not be captured.
    expect(parseAskCustomId("session:compact")).toBeNull();
    expect(isAskComponentId("session:compact")).toBe(false);
    expect(parseAskCustomId(ASK_COMPONENT_PREFIX)).toBeNull();
    expect(parseAskCustomId(`${ASK_COMPONENT_PREFIX}abc1:x`)).toBeNull();
    expect(parseAskCustomId(`${ASK_COMPONENT_PREFIX}abc1:-1`)).toBeNull();
    expect(parseAskCustomId(`${ASK_COMPONENT_PREFIX}abc1:1:2`)).toBeNull();
  });
});

// --- click handling --------------------------------------------------------

describe("ask component handler (#412)", () => {
  test("button click answers with the label, disables the row, records the choice", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      {
        threadId: "thread-1",
        question: "方針は？",
        options: [`案A${OPTION_SEPARATOR}既定`, "案B"],
      },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:1`,
    });

    await handler(interaction as never);

    expect(resolved).toEqual([{ threadId: "thread-1", answer: "案B" }]);
    const update = replies.find((r) => r.kind === "update");
    expect(update?.content).toContain("選択: 案B");
    // The original question stays readable above the recorded choice.
    expect(update?.content).toContain("方針は？");
    const disabled = rowJson(update?.components?.[0]).components as {
      disabled?: boolean;
    }[];
    expect(disabled.every((c) => c.disabled === true)).toBe(true);
  });

  test("answering with the label drops the description the hook appended", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      {
        threadId: "thread-1",
        question: "方針は？",
        options: [`案A${OPTION_SEPARATOR}既定を維持する`],
      },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
    });

    await handler(interaction as never);

    // AskUserQuestion's own dialog returns the label; the description is help
    // text, not the answer.
    expect(resolved[0]?.answer).toBe("案A");
  });

  test("second click does not answer twice (AC-3)", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A", "案B"] },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });

    const first = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
    });
    await handler(first.interaction as never);
    const second = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:1`,
    });
    await handler(second.interaction as never);

    expect(resolved).toHaveLength(1);
    const reply = second.replies.find((r) => r.kind === "reply");
    expect(reply?.content).toContain("回答済み");
    expect(reply?.content).toContain("案A");
    expect(reply?.flags).toBe(64);
  });

  test("click after the relay timed out reports expiry, never a silent no-op (AC-4)", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A"] },
      registry
    );
    const { handler, resolved } = makeHandler({ registry, pending: false });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
    });

    await handler(interaction as never);

    expect(resolved).toHaveLength(0);
    const reply = replies.find((r) => r.kind === "reply");
    expect(reply?.content).toContain("期限");
    expect(reply?.flags).toBe(64);
    // The dead message must stop inviting clicks.
    expect(replies.some((r) => r.kind === "messageEdit")).toBe(true);
  });

  test("a superseded prompt cannot answer the newer question", async () => {
    const registry = new AskPromptRegistry();
    const first = buildAskPrompt(
      { threadId: "thread-1", question: "Q1", options: ["案A"] },
      registry
    );
    // The relay replaces an in-flight ask for the same thread (499), so a stale
    // click here would otherwise answer Q2 with Q1's option.
    buildAskPrompt(
      { threadId: "thread-1", question: "Q2", options: ["案X"] },
      registry
    );

    const { handler, resolved } = makeHandler({ registry });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${first.token}:0`,
    });
    await handler(interaction as never);

    expect(resolved).toHaveLength(0);
    expect(replies.find((r) => r.kind === "reply")?.content).toContain(
      "新しい質問"
    );
  });

  test("an EXPIRED prompt cannot answer the newer question (PR #427 must-2)", async () => {
    const registry = new AskPromptRegistry();
    const first = buildAskPrompt(
      { threadId: "thread-1", question: "Q1", options: ["案A"] },
      registry
    );

    // 1) The relay times out and the 会長 clicks the dead message: state = expired.
    const expiredRun = makeHandler({ registry, pending: false });
    const stale = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${first.token}:0`,
    });
    await expiredRun.handler(stale.interaction as never);
    expect(expiredRun.resolved).toHaveLength(0);

    // 2) A NEW ask arrives on the same thread and is now the pending one.
    buildAskPrompt(
      { threadId: "thread-1", question: "Q2", options: ["案X"] },
      registry
    );

    // 3) Clicking the OLD message must not answer Q2 with Q1's option.
    // hasPendingAsk is per-thread, so without superseding the expired prompt
    // this used to sail through and resolve the new ask.
    const { handler, resolved } = makeHandler({ registry });
    const again = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${first.token}:0`,
    });
    await handler(again.interaction as never);

    expect(resolved).toHaveLength(0);
    expect(again.replies.find((r) => r.kind === "reply")?.content).toBeDefined();
  });

  test("expired is terminal: a re-click keeps reporting expiry, not the newer ask's state", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A"] },
      registry
    );
    const first = makeHandler({ registry, pending: false });
    const click1 = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
    });
    await first.handler(click1.interaction as never);

    // Same prompt, but now the thread has a pending ask again (a later question).
    const second = makeHandler({ registry, pending: true });
    const click2 = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
    });
    await second.handler(click2.interaction as never);

    expect(second.resolved).toHaveLength(0);
    expect(click2.replies.find((r) => r.kind === "reply")?.content).toContain(
      "期限"
    );
  });

  test("a long question is trimmed, the recorded choice is not (PR #427 should-4)", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A"] },
      registry
    );
    const { handler } = makeHandler({ registry });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
      // A question already at the content ceiling: appending the choice and
      // truncating the whole thing would drop exactly the choice.
      messageContent: "長".repeat(1900),
    });

    await handler(interaction as never);

    const update = replies.find((r) => r.kind === "update");
    expect(update?.content).toContain("✅ 選択: 案A");
    expect((update?.content ?? "").length).toBeLessThanOrEqual(2000);
  });

  test("unknown token (restart / evicted) is reported, not ignored", async () => {
    const registry = new AskPromptRegistry();
    const { handler, resolved } = makeHandler({ registry });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}gone9:0`,
    });

    await handler(interaction as never);

    expect(resolved).toHaveLength(0);
    expect(replies.find((r) => r.kind === "reply")?.flags).toBe(64);
  });

  test("out-of-range index is reported, never resolved as some other option", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A"] },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:7`,
    });

    await handler(interaction as never);

    expect(resolved).toHaveLength(0);
    expect(replies.find((r) => r.kind === "reply")?.content).toContain(
      "解釈できませんでした"
    );
  });

  test("click from another thread is refused (token/thread mismatch)", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A"] },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
      channelId: "thread-other",
    });

    await handler(interaction as never);

    expect(resolved).toHaveLength(0);
  });

  test("multi-select answers with every chosen label", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      {
        threadId: "thread-1",
        question: "どれを含める？",
        options: ["案A", "案B", "案C"],
        multiSelect: true,
      },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}`,
      values: ["0", "2"],
    });

    await handler(interaction as never);

    expect(resolved).toEqual([{ threadId: "thread-1", answer: "案A, 案C" }]);
  });

  test("a failed message update does not lose the delivered answer", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A"] },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
      updateThrows: true,
    });

    // The session is blocked on the answer; a cosmetic edit failure must not
    // take it down with it.
    await handler(interaction as never);
    expect(resolved).toEqual([{ threadId: "thread-1", answer: "案A" }]);
  });
});

// --- authorization (#427 review must-1) ------------------------------------

describe("tap authorization (#412 / PR #427 must-1)", () => {
  test("a tap from a sender the policy denies never answers", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A", "案B"] },
      registry
    );
    const { handler, resolved } = makeHandler({
      registry,
      access: { allowed: false, reason: "sender_not_allowlisted" },
    });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
      userId: "user-stranger",
    });

    await handler(interaction as never);

    // A tap and a text reply commit the same thing — the owner's answer — so an
    // un-gated tap would be the same failure class this feature exists to fix.
    expect(resolved).toHaveLength(0);
    const reply = replies.find((r) => r.kind === "reply");
    expect(reply?.content).toContain("権限がありません");
    expect(reply?.flags).toBe(64);
    // Denied clicks must not silently disarm the message for the real owner.
    expect(replies.some((r) => r.kind === "update")).toBe(false);
  });

  test("the gate is keyed on the parent channel and treats a click as addressed to the bot", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A"] },
      registry
    );
    const { handler, resolved, accessQueries } = makeHandler({ registry });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
      parentId: "parent-1",
      userId: "user-owner",
    });

    await handler(interaction as never);

    // Same key as messageCreate (`parentId ?? threadId`), so the two answer
    // paths cannot be allow-listed differently.
    expect(accessQueries).toEqual([
      { channelKey: "parent-1", userId: "user-owner", isMention: true },
    ]);
    // isMention: true is load-bearing — every group defaults requireMention:true,
    // so passing false here would deny every tap.
    expect(resolved).toHaveLength(1);
  });

  test("a denied tap is logged with the reason only (no snowflake, no body)", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "秘密の質問", options: ["案A"] },
      registry
    );
    const { handler } = makeHandler({
      registry,
      access: { allowed: false, reason: "policy_unavailable" },
    });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:0`,
      userId: "111222333444555666",
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await handler(interaction as never);
      const lines = warn.mock.calls.map((c) => c.join(" "));
      expect(lines.some((l) => l.includes("policy_unavailable"))).toBe(true);
      expect(lines.some((l) => l.includes("111222333444555666"))).toBe(false);
      expect(lines.some((l) => l.includes("秘密の質問"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

// --- decision trail (#427 review should-1) ---------------------------------

describe("decision trail (#412 / PR #427 should-1)", () => {
  test("a successful answer is logged with thread, token and choice, without the raw user id", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A", "案B"] },
      registry
    );
    const { handler } = makeHandler({ registry });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:1`,
      userId: "111222333444555666",
    });
    const log = spyOn(console, "log").mockImplementation(() => {});

    try {
      await handler(interaction as never);
      const lines = log.mock.calls.map((c) => c.join(" "));
      const answered = lines.find((l) => l.includes("answered"));
      // "I tapped it and nothing happened" must be answerable from the log.
      expect(answered).toBeDefined();
      expect(answered).toContain("thread-1");
      expect(answered).toContain(prompt.token!);
      expect(answered).toContain("案B");
      // The actor is identified by a hash, never the snowflake.
      expect(answered).not.toContain("111222333444555666");
      expect(answered).toMatch(/actor [0-9a-f]{8}/);
    } finally {
      log.mockRestore();
    }
  });
});

// --- coupled contracts -----------------------------------------------------

describe("coupled contracts (#412)", () => {
  test("the hook's option separator is the one we split on", () => {
    // hooks/ask-user-relay.sh flattens each option to `label — description`.
    // AskUserEvent carries only those strings, so if the hook's separator
    // changes, splitOption silently starts answering with the whole string.
    // Lock the pair here (same style as the --max-time invariant in
    // relay-server.test.ts).
    const hook = readFileSync(
      resolve(import.meta.dir, "../../hooks/ask-user-relay.sh"),
      "utf8"
    );
    expect(hook).toContain(`"${OPTION_SEPARATOR}"`);
  });

  test("bot.ts wires handleAskUser through postAskUserPrompt", () => {
    // #370's failure class: a relay path that exists but is not wired. Text
    // matching can only prove bot.ts calls the right function, not that the
    // function actually produces a correct post — that gap is closed by the
    // postAskUserPrompt describe block below, which drives the real send().
    const bot = readFileSync(
      resolve(import.meta.dir, "../../src/bot.ts"),
      "utf8"
    );
    expect(bot).toMatch(/postAskUserPrompt\(channel,\s*{/);
    // And the interaction dispatcher must route both component kinds.
    expect(bot).toMatch(/isAskComponentId\(interaction\.customId\)/);
    // #443: a multi-question event must reach postMultiAskUserPrompt, and a
    // plain-text reply must be gated by hasActiveMultiAsk before it can
    // resolve a pending ask (AC-3) — same failure class as #370, one hop
    // earlier: the branch existing but never being taken.
    expect(bot).toMatch(/postMultiAskUserPrompt\(channel,\s*{/);
    expect(bot).toMatch(/hasActiveMultiAsk\(threadId\)/);
    // #447: after either post branch, the parent channel gets the pending
    // notice, and the helper delivers it via postAskChannelNotice. Same
    // failure class again — the notice existing but never being wired.
    expect(bot).toMatch(/notifyAskParentChannel\(\s*client,\s*channel,/);
    expect(bot).toMatch(/postAskChannelNotice\(/);
  });
});

describe("postAskUserPrompt (Issue #436 V-2)", () => {
  // Nothing before this point fed buildAskPrompt's output into an actual
  // send(): ask-components.test.ts covers buildAskPrompt in isolation, and
  // startup-wiring.test.ts only proves handleAskUser is registered — neither
  // ever executes it. These tests drive the exact call bot.ts makes, with a
  // fake channel standing in for the live Discord send that could not be
  // verified for two days after #427/#431 shipped (Issue #436).
  function makeChannel() {
    const sent: {
      content: string;
      components?: unknown[];
    }[] = [];
    const channel: AskPostChannel = {
      send: async (options) => {
        sent.push(options);
        return { id: "message-1" };
      },
    };
    return { channel, sent };
  }

  test("delivers buttons for a 2-option question, with the real deadline and no-auto-select notice", async () => {
    const registry = new AskPromptRegistry();
    const { channel, sent } = makeChannel();

    const prompt = await postAskUserPrompt(
      channel,
      {
        threadId: "thread-1",
        question: "A か B か？",
        options: ["A", "B"],
        timeoutMs: 5 * 60 * 60 * 1000,
      },
      registry
    );

    expect(sent).toHaveLength(1);
    expect(prompt.kind).toBe("buttons");
    // 期待2: the wait notice states the real deadline, not a stale hardcode.
    expect(sent[0]!.content).toContain("約 5 時間");
    // 期待3: the no-auto-select line (Issue #423) is present verbatim.
    expect(sent[0]!.content).toContain(
      "選択肢が自動で選ばれることはありません（Issue #423）"
    );
    // 期待1: components reach send(), not just the text.
    expect(sent[0]!.components).toBeDefined();
    expect(sent[0]!.components).toHaveLength(1);
    const ids = customIds(sent[0]!.components![0]);
    expect(ids).toHaveLength(2);
  });

  test("delivers a select menu once options exceed the button limit", async () => {
    const registry = new AskPromptRegistry();
    const { channel, sent } = makeChannel();

    await postAskUserPrompt(
      channel,
      {
        threadId: "thread-1",
        question: "方針は？",
        options: ["A", "B", "C", "D", "E", "F"],
        timeoutMs: 30 * 60 * 1000,
      },
      registry
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain("約 30 分");
    const menu = rowJson(sent[0]!.components![0]).components[0] as {
      options: { label: string }[];
    };
    expect(menu.options.map((o) => o.label)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
    ]);
  });

  test("sends text-only (no components key) when the ask carries no options", async () => {
    // Multi-question asks flatten to a bare question with no options — the
    // send() call must omit `components` entirely rather than send `[]`,
    // matching what buildAskPrompt already guarantees for this shape.
    const registry = new AskPromptRegistry();
    const { channel, sent } = makeChannel();

    await postAskUserPrompt(
      channel,
      { threadId: "thread-1", question: "自由記述でお願いします" },
      registry
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.components).toBeUndefined();
    expect(sent[0]!.content).toContain("自由記述でお願いします");
  });
});

// --- parent-channel pending notice (Issue #447) -----------------------------

describe("ask parent-channel notice (#447)", () => {
  test("buildAskChannelNotice carries the count and a tappable thread mention", () => {
    // Journey AC-1/AC-2: `<#id>` is Discord's channel mention — it resolves
    // for threads too, so one tap in the parent channel opens the thread
    // holding the question.
    const notice = buildAskChannelNotice("123456789012345678", 3);
    expect(notice).toBe("📥 決裁待ち 3 件 → <#123456789012345678>");
  });

  test("postAskChannelNotice sends exactly one message, content only", async () => {
    const sent: { content: string; components?: unknown[] }[] = [];
    const parent: AskPostChannel = {
      send: async (options) => {
        sent.push(options);
        return { id: "notice-1" };
      },
    };

    await postAskChannelNotice(parent, {
      threadId: "thread-1",
      questionCount: 1,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toBe("📥 決裁待ち 1 件 → <#thread-1>");
    // A notice never carries components — the answerable UI lives only in the
    // thread (answer routing is per-thread; #447 rejected 案 A for this).
    expect(sent[0]!.components).toBeUndefined();
  });

  test("a failing parent send propagates to the caller (bot.ts owns the best-effort catch)", async () => {
    // Journey AC-3 (isolation): the helper itself does not swallow errors —
    // bot.ts wraps it so a notice failure never reads as an ask failure. The
    // wiring test above pins that the call sits inside notifyAskParentChannel.
    const parent: AskPostChannel = {
      send: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      postAskChannelNotice(parent, { threadId: "t", questionCount: 2 }),
    ).rejects.toThrow("boom");
  });
});

// --- multi-question ask (Issue #443) ----------------------------------------

describe("buildMultiAskPrompt (#443)", () => {
  test("one ActionRow per question, each with its own token/customIds", () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1 はどうしますか？", options: ["案A", "案B"] },
          { question: "Q2 はどうしますか？", options: ["案C"] },
        ],
      },
      registry
    );

    expect(prompt.kind).not.toBe("text");
    expect(prompt.components).toHaveLength(2);
    expect(prompt.tokens).toHaveLength(2);
    expect(prompt.token).toBeUndefined();

    const row0 = customIds(prompt.components[0]);
    const row1 = customIds(prompt.components[1]);
    expect(row0).toEqual([
      `${ASK_COMPONENT_PREFIX}${prompt.tokens![0]}:0`,
      `${ASK_COMPONENT_PREFIX}${prompt.tokens![0]}:1`,
    ]);
    expect(row1).toEqual([`${ASK_COMPONENT_PREFIX}${prompt.tokens![1]}:0`]);
    // Different tokens: each question is its own independent registry entry.
    expect(prompt.tokens![0]).not.toBe(prompt.tokens![1]);

    expect(prompt.content).toContain("Q1 はどうしますか？");
    expect(prompt.content).toContain("Q2 はどうしますか？");
    expect(prompt.content).toContain("再開します");
  });

  test("registering siblings does not supersede each other (unlike two unrelated asks)", () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A"] },
          { question: "Q2", options: ["案B"] },
        ],
      },
      registry
    );

    // Both siblings are still pending — registering Q2 must not have disabled
    // Q1's row the way a second unrelated buildAskPrompt call would.
    const first = registry.get(prompt.tokens![0]!);
    const second = registry.get(prompt.tokens![1]!);
    expect(first?.state).toBe("pending");
    expect(second?.state).toBe("pending");
  });

  test("a genuinely new ask still supersedes an unanswered multi-question batch", () => {
    const registry = new AskPromptRegistry();
    const multi = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A"] },
          { question: "Q2", options: ["案B"] },
        ],
      },
      registry
    );

    // A later solo ask on the same thread replaces the whole pending batch.
    buildAskPrompt({ threadId: "thread-1", question: "Q3", options: ["案C"] }, registry);

    expect(registry.get(multi.tokens![0]!)?.state).toBe("superseded");
    expect(registry.get(multi.tokens![1]!)?.state).toBe("superseded");
  });

  test("falls back to the flattened text-only post when a sub-question has no options", () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1 はどうしますか？", options: ["案A"] },
          { question: "Q2 は自由記述です" }, // no options
        ],
      },
      registry
    );

    expect(prompt.kind).toBe("text");
    expect(prompt.components).toHaveLength(0);
    expect(prompt.tokens).toBeUndefined();
    expect(registry.size()).toBe(0);
    expect(prompt.content).toContain("Q1 はどうしますか？");
    expect(prompt.content).toContain("Q2 は自由記述です");
  });

  test("falls back to text when there are more questions than Discord has rows for", () => {
    const registry = new AskPromptRegistry();
    const questions = Array.from({ length: MAX_ASK_QUESTIONS_PER_MESSAGE + 1 }, (_, i) => ({
      question: `Q${i + 1}`,
      options: ["A"],
    }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const prompt = buildMultiAskPrompt({ threadId: "thread-1", questions }, registry);
      expect(prompt.kind).toBe("text");
      expect(prompt.components).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("falls back to text (whole batch) when one question has more options than Discord's select ceiling (PR #444 review)", () => {
    // Without this guard buildSelectRow would hand Discord a StringSelectMenu
    // with > MAX_SELECT_OPTIONS entries — the actual send() call would fail
    // outright rather than degrade, unlike the solo-ask path (buildAskPrompt)
    // which already guards this.
    const registry = new AskPromptRegistry();
    const tooMany = Array.from({ length: MAX_SELECT_OPTIONS + 1 }, (_, i) => `選択肢${i + 1}`);
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const prompt = buildMultiAskPrompt(
        {
          threadId: "thread-1",
          questions: [
            { question: "Q1", options: ["A", "B"] },
            { question: "Q2（選択肢が多すぎる）", options: tooMany },
          ],
        },
        registry
      );
      expect(prompt.kind).toBe("text");
      expect(prompt.components).toHaveLength(0);
      expect(registry.size()).toBe(0); // neither question got registered
      expect(prompt.content).toContain("Q1");
      expect(prompt.content).toContain("Q2（選択肢が多すぎる）");
    } finally {
      warn.mockRestore();
    }
  });

  test("falls back to text for zero questions", () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt({ threadId: "thread-1", questions: [] }, registry);
    expect(prompt.kind).toBe("text");
    expect(prompt.components).toHaveLength(0);
  });

  test("a question needing multiSelect gets a select row even below the button limit", () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A", "案B"] },
          { question: "Q2（複数選択可）", options: ["x", "y"], multiSelect: true },
        ],
      },
      registry
    );

    expect(prompt.components).toHaveLength(2);
    const menu = rowJson(prompt.components[1]).components[0] as {
      max_values?: number;
    };
    expect(menu.max_values).toBe(2);
  });
});

describe("postMultiAskUserPrompt (#443)", () => {
  function makeChannel() {
    const sent: { content: string; components?: unknown[] }[] = [];
    const channel: AskPostChannel = {
      send: async (options) => {
        sent.push(options);
        return { id: "message-1" };
      },
    };
    return { channel, sent };
  }

  test("delivers all rows in a single send()", async () => {
    const registry = new AskPromptRegistry();
    const { channel, sent } = makeChannel();

    const prompt = await postMultiAskUserPrompt(
      channel,
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A", "案B"] },
          { question: "Q2", options: ["案C"] },
          { question: "Q3", options: ["案D"] },
        ],
        timeoutMs: 5 * 60 * 60 * 1000,
      },
      registry
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.components).toHaveLength(3);
    expect(prompt.tokens).toHaveLength(3);
  });
});

describe("multi-question click resolution (#443 AC-1/AC-2)", () => {
  test("tapping one of two questions does not resolve; the other stays live", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A", "案B"] },
          { question: "Q2", options: ["案C"] },
        ],
      },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![0]}:1`, // Q1 -> 案B
      messageContent: prompt.content,
    });

    await handler(interaction as never);

    // The underlying /ask has not been resolved — Q2 was never tapped.
    expect(resolved).toHaveLength(0);
    const update = replies.find((r) => r.kind === "update");
    expect(update?.content).toContain("✅ Q1 選択: 案B");
    const rows = (update?.components ?? []) as unknown[];
    expect(rows).toHaveLength(2);
    // Q1's row is now disabled...
    const row0 = rowJson(rows[0]).components as { disabled?: boolean }[];
    expect(row0.every((c) => c.disabled === true)).toBe(true);
    // ...Q2's row is untouched and still tappable.
    const row1 = rowJson(rows[1]).components as { disabled?: boolean }[];
    expect(row1.every((c) => c.disabled !== true)).toBe(true);
  });

  test("answering every question resolves the ask exactly once, combining all answers", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A", "案B"] },
          { question: "Q2", options: ["案C"] },
        ],
      },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });

    const first = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![0]}:1`,
      messageContent: prompt.content,
    });
    await handler(first.interaction as never);
    expect(resolved).toHaveLength(0);

    const second = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![1]}:0`,
      // The message content by now already carries Q1's confirmation line —
      // mirrors what interaction.update() actually left behind.
      messageContent: `${prompt.content}\n\n✅ Q1 選択: 案B`,
    });
    await handler(second.interaction as never);

    // Resolves exactly once, with both answers — never twice, never with
    // just the second tap's answer.
    expect(resolved).toEqual([
      { threadId: "thread-1", answer: "Q1: 案B\nQ2: 案C" },
    ]);

    const update = second.replies.find((r) => r.kind === "update");
    expect(update?.content).toContain("✅ Q1 選択: 案B");
    expect(update?.content).toContain("✅ Q2 選択: 案C");
    const rows = (update?.components ?? []) as unknown[];
    for (const row of rows) {
      const buttons = rowJson(row).components as { disabled?: boolean }[];
      expect(buttons.every((c) => c.disabled === true)).toBe(true);
    }
  });

  test("re-tapping an already-answered question in the batch is refused, not a second resolve", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A"] },
          { question: "Q2", options: ["案B"] },
        ],
      },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });

    const first = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![0]}:0`,
    });
    await handler(first.interaction as never);

    const again = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![0]}:0`,
    });
    await handler(again.interaction as never);

    expect(resolved).toHaveLength(0); // Q2 never answered
    const reply = again.replies.find((r) => r.kind === "reply");
    expect(reply?.content).toContain("回答済み");
  });

  test("a solo ask still resolves on the first tap (group of one, unchanged behaviour)", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["案A", "案B"] },
      registry
    );
    const { handler, resolved } = makeHandler({ registry });
    const { interaction } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.token}:1`,
    });

    await handler(interaction as never);

    // Exactly the old solo format — no "Q1:" label, no group join.
    expect(resolved).toEqual([{ threadId: "thread-1", answer: "案B" }]);
  });

  test("a click on a dead multi-question ask (relay timed out) disables EVERY sibling row, not just the one tapped (#443 review must-1)", async () => {
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A"] },
          { question: "Q2", options: ["案B"] },
          { question: "Q3", options: ["案C"] },
        ],
      },
      registry
    );
    // pending: false -> the relay already gave up waiting on this thread.
    const { handler } = makeHandler({ registry, pending: false });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![1]}:0`, // taps Q2 only
    });

    await handler(interaction as never);

    const edit = replies.find((r) => r.kind === "messageEdit");
    const rows = (edit?.components ?? []) as unknown[];
    // A naive fix that only rebuilds the clicked row would drop Q1 and Q3
    // from the message entirely (Discord replaces the whole array). All
    // three must still be present, all disabled — the whole batch is dead,
    // not just the tapped question.
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const buttons = rowJson(row).components as { disabled?: boolean }[];
      expect(buttons.every((c) => c.disabled === true)).toBe(true);
    }
  });

  test("a superseded multi-question ask also disables every sibling row on a stale click", async () => {
    const registry = new AskPromptRegistry();
    const first = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A"] },
          { question: "Q2", options: ["案B"] },
        ],
      },
      registry
    );
    buildAskPrompt({ threadId: "thread-1", question: "Q3", options: ["案C"] }, registry);

    const { handler } = makeHandler({ registry });
    const { interaction, replies } = makeInteraction({
      customId: `${ASK_COMPONENT_PREFIX}${first.tokens![0]}:0`,
    });
    await handler(interaction as never);

    const edit = replies.find((r) => r.kind === "messageEdit");
    const rows = (edit?.components ?? []) as unknown[];
    expect(rows).toHaveLength(2); // Q1 + Q2, not just Q1
  });
});

describe("AskPromptRegistry eviction (#443 review should-2)", () => {
  test("a still-pending member of an open multi-question group is skipped in favour of a stale entry", () => {
    const registry = new AskPromptRegistry(3);
    // Two solo asks on an unrelated thread: the second immediately supersedes
    // the first, so the registry already holds one terminal (evictable) entry
    // before the group below is registered.
    buildAskPrompt({ threadId: "thread-a", question: "old-1", options: ["x"] }, registry);
    buildAskPrompt({ threadId: "thread-a", question: "old-2", options: ["x"] }, registry);

    // Registering this 2-member group pushes size from 2 -> 4, one over
    // capacity, forcing exactly one eviction.
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-b",
        questions: [
          { question: "Q1", options: ["案A"] },
          { question: "Q2", options: ["案B"] },
        ],
      },
      registry
    );

    // Both siblings must survive — the eviction should have taken the stale
    // superseded entry instead. Evicting either sibling would let groupOf()
    // see only the other one and resolve the ask as if the evicted question
    // had been answered.
    expect(registry.get(prompt.tokens![0]!)).toBeDefined();
    expect(registry.get(prompt.tokens![1]!)).toBeDefined();
    expect(registry.size()).toBe(3);
  });

  test("bounds the map even in the pathological case where every live entry is a group member", () => {
    // Capacity 1 with a 2-member group: there is no stale entry to sacrifice,
    // so the safety net (never grow past capacity) must win over "never evict
    // a live group member" — the map stays bounded even though it means one
    // sibling goes down. This is the documented fallback, not the common case.
    const registry = new AskPromptRegistry(1);
    buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A"] },
          { question: "Q2", options: ["案B"] },
        ],
      },
      registry
    );

    expect(registry.size()).toBeLessThanOrEqual(1);
  });

  test("an answered or solo prompt is still evicted normally once capacity is exceeded", () => {
    const registry = new AskPromptRegistry(1);
    const solo = buildAskPrompt(
      { threadId: "thread-1", question: "Q0", options: ["案Z"] },
      registry
    );
    // A second, unrelated solo ask forces eviction pressure. The first one
    // (superseded, i.e. terminal) is a safe eviction target.
    buildAskPrompt({ threadId: "thread-1", question: "Q1", options: ["案A"] }, registry);

    expect(registry.get(solo.token!)).toBeUndefined();
  });

  test("an ALREADY-ANSWERED sibling of a still-open group is protected too, not just pending ones (PR #444 review, must)", async () => {
    const registry = new AskPromptRegistry(3);
    // Two stale solo asks to absorb the evictions this test forces.
    buildAskPrompt({ threadId: "thread-a", question: "old-1", options: ["x"] }, registry);
    buildAskPrompt({ threadId: "thread-a", question: "old-2", options: ["x"] }, registry);

    // Registered under "thread-1" — makeInteraction()'s default channelId —
    // so the click below isn't rejected as cross-thread; the eviction pool
    // (old-1/old-2) lives on the separate "thread-a" and is never clicked.
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["案A"] },
          { question: "Q2", options: ["案B"] },
        ],
      },
      registry
    );
    // size is now 4 (over capacity 3); registering already evicted once
    // (see the sibling-preference test above) — answer Q1 so it becomes
    // "answered" while Q2 is still pending, i.e. the group is NOT resolved.
    const { handler } = makeHandler({ registry });
    await handler(
      makeInteraction({ customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![0]}:0` })
        .interaction as never
    );
    expect(registry.get(prompt.tokens![0]!)?.state).toBe("answered");

    // Force more eviction pressure without touching this group: register
    // another unrelated solo ask that immediately supersedes old-2.
    buildAskPrompt({ threadId: "thread-a", question: "old-3", options: ["x"] }, registry);

    // A naive "protect pending members only" check would have evicted Q1
    // (answered, not pending) the moment capacity pressure hit — losing its
    // answer from the eventual combined response. It must still be here.
    expect(registry.get(prompt.tokens![0]!)).toBeDefined();
    expect(registry.get(prompt.tokens![1]!)).toBeDefined();
  });
});

describe("hasActiveMultiAsk (#443 AC-3)", () => {
  test("true while a multi-question batch has any unanswered sibling", () => {
    const registry = new AskPromptRegistry();
    buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["A"] },
          { question: "Q2", options: ["B"] },
        ],
      },
      registry
    );

    expect(hasActiveMultiAsk("thread-1", registry)).toBe(true);
    expect(hasActiveMultiAsk("thread-other", registry)).toBe(false);
  });

  test("false for a solo (single-question) ask", () => {
    const registry = new AskPromptRegistry();
    buildAskPrompt(
      { threadId: "thread-1", question: "方針は？", options: ["A", "B"] },
      registry
    );

    expect(hasActiveMultiAsk("thread-1", registry)).toBe(false);
  });

  test("false once a newer ask has superseded the batch", () => {
    const registry = new AskPromptRegistry();
    buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["A"] },
          { question: "Q2", options: ["B"] },
        ],
      },
      registry
    );
    buildAskPrompt({ threadId: "thread-1", question: "Q3", options: ["C"] }, registry);

    expect(hasActiveMultiAsk("thread-1", registry)).toBe(false);
  });

  test("defaults to the module-level registry when none is passed", () => {
    // Smoke test only: proves the wrapper is callable without an explicit
    // registry (bot.ts calls it this way).
    expect(hasActiveMultiAsk("thread-that-has-never-asked-anything")).toBe(false);
  });

  test("false once a multi-question batch is FULLY answered, even though its entries stay in the registry (PR #444 review, must)", async () => {
    // A completed group's members end up `"answered"`, which register()'s
    // supersede loop deliberately never touches — they just sit there. A
    // naive count-only check would still see 2+ entries for that groupId and
    // report "active", wrongly blocking a LATER solo ask's plain-text reply.
    const registry = new AskPromptRegistry();
    const prompt = buildMultiAskPrompt(
      {
        threadId: "thread-1",
        questions: [
          { question: "Q1", options: ["A"] },
          { question: "Q2", options: ["B"] },
        ],
      },
      registry
    );
    const { handler } = makeHandler({ registry });
    await handler(
      makeInteraction({ customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![0]}:0` })
        .interaction as never
    );
    await handler(
      makeInteraction({ customId: `${ASK_COMPONENT_PREFIX}${prompt.tokens![1]}:0` })
        .interaction as never
    );

    expect(hasActiveMultiAsk("thread-1", registry)).toBe(false);

    // A subsequent solo ask on the same thread must not be treated as multi.
    buildAskPrompt({ threadId: "thread-1", question: "Q3", options: ["C"] }, registry);
    expect(hasActiveMultiAsk("thread-1", registry)).toBe(false);
  });
});
