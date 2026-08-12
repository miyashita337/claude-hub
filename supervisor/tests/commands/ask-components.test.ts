import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  ASK_COMPONENT_PREFIX,
  AskPromptRegistry,
  BUTTON_LABEL_LIMIT,
  CUSTOM_ID_LIMIT,
  MAX_BUTTON_OPTIONS,
  MAX_SELECT_OPTIONS,
  OPTION_SEPARATOR,
  SELECT_DESCRIPTION_LIMIT,
  buildAskPrompt,
  createAskComponentHandler,
  isAskComponentId,
  parseAskCustomId,
  shouldUseButtons,
  splitOption,
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
  messageContent?: string;
  updateThrows?: boolean;
  editThrows?: boolean;
}) {
  const replies: ReplyRecord[] = [];
  const isSelect = opts.values !== undefined;

  const interaction = {
    customId: opts.customId,
    values: opts.values ?? [],
    channelId: opts.channelId ?? "thread-1",
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

function makeHandler(opts: { pending?: boolean; registry: AskPromptRegistry }) {
  const resolved: { threadId: string; answer: string }[] = [];
  const handler = createAskComponentHandler({
    hasPendingAsk: () => opts.pending ?? true,
    resolveAskUser: (threadId, answer) => {
      resolved.push({ threadId, answer });
    },
    registry: opts.registry,
  });
  return { handler, resolved };
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

  test("bot.ts sends the built components, not just the text", () => {
    // #370's failure class: a relay path that exists but is not wired. The
    // components only reach Discord if handleAskUser passes them to send() —
    // assert the call site so a future edit cannot drop them back to text-only
    // while every unit test above still passes.
    const bot = readFileSync(
      resolve(import.meta.dir, "../../src/bot.ts"),
      "utf8"
    );
    expect(bot).toContain("buildAskPrompt({");
    expect(bot).toMatch(/components:\s*prompt\.components/);
    // And the interaction dispatcher must route both component kinds.
    expect(bot).toMatch(/isAskComponentId\(interaction\.customId\)/);
  });
});
