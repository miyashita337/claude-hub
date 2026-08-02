import { test, expect, describe } from "bun:test";
import { ButtonStyle } from "discord.js";
import {
  COMPACT_BUTTON_ID,
  DEFAULT_COMPACT_INTENT,
  buildCompactButtonRow,
  createCompactButtonHandler,
  withCompactButton,
} from "../../src/commands/compact-button";

/**
 * One-click compact button (Issue #364).
 *
 * Mirrors session-compact.test.ts: a minimal fake ButtonInteraction exercises
 * the real handler without a Discord gateway. What matters here is that the
 * button reaches the *same* compact path as `/session compact` (so the two can't
 * drift) and that a stale button on a dead thread never sends keys.
 */

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

function makeInteraction(opts: {
  inThread?: boolean;
  hasSession?: boolean;
  compactImpl?: (threadId: string, intent: string) => unknown;
}) {
  const replies: ReplyRecord[] = [];
  const compactCalls: { threadId: string; intent: string }[] = [];

  const inThread = opts.inThread ?? true;
  const channel = { id: "thread-btn-1", isThread: () => inThread };

  const interaction = {
    customId: COMPACT_BUTTON_ID,
    channel,
    deferred: false,
    replied: false,
    async reply(msg: { content?: string; flags?: number }) {
      this.replied = true;
      replies.push({ kind: "reply", content: msg.content, flags: msg.flags });
    },
    async deferReply(msg?: { flags?: number }) {
      this.deferred = true;
      replies.push({ kind: "reply", flags: msg?.flags });
    },
    async editReply(msg: { content?: string }) {
      replies.push({ kind: "editReply", content: msg.content });
    },
  };

  const sessionManager = {
    has: () => opts.hasSession ?? true,
    compactSession: async (threadId: string, intent: string) => {
      compactCalls.push({ threadId, intent });
      return opts.compactImpl?.(threadId, intent);
    },
  };

  return {
    run: () =>
      createCompactButtonHandler(sessionManager as never)(interaction as never),
    replies,
    compactCalls,
  };
}

describe("compact button component (#364)", () => {
  test("row carries a single button with the app-scoped customId", () => {
    const json = buildCompactButtonRow().toJSON();

    expect(json.components).toHaveLength(1);
    const button = json.components[0] as {
      custom_id?: string;
      label?: string;
      style?: number;
    };
    // The customId is what makes this immune to the /compact name collision:
    // Discord routes the component back to the app that sent the message.
    expect(button.custom_id).toBe(COMPACT_BUTTON_ID);
    expect(button.label).toBe("compact");
    expect(button.style).toBe(ButtonStyle.Secondary);
  });

  test("withCompactButton attaches the row only when compact is the next step", () => {
    const offered = withCompactButton("長時間稼働しています", true);
    expect(offered.content).toBe("長時間稼働しています");
    expect(offered.components).toHaveLength(1);

    // An unrelated warning must not grow a misleading button.
    const plain = withCompactButton("無活動です", false);
    expect(plain.content).toBe("無活動です");
    expect(plain.components).toBeUndefined();
  });
});

describe("compact button handler (#364)", () => {
  test("running session: compacts with the default intent, ephemeral ack (RW-032)", async () => {
    const fx = makeInteraction({});
    await fx.run();

    // Never a bare /compact — the button has no intent field, so the default is
    // the only thing standing between it and a bad compact.
    expect(fx.compactCalls).toEqual([
      { threadId: "thread-btn-1", intent: DEFAULT_COMPACT_INTENT },
    ]);
    expect(fx.replies.some((r) => r.flags === 64)).toBe(true);
    const ack = fx.replies.find((r) => r.kind === "editReply");
    expect(ack?.content).toContain(`/compact ${DEFAULT_COMPACT_INTENT}`);
  });

  test("stale button on a stopped session: hint only, no send-keys", async () => {
    const fx = makeInteraction({ hasSession: false });
    await fx.run();

    expect(fx.compactCalls).toHaveLength(0);
    const reply = fx.replies.find((r) => r.kind === "reply");
    expect(reply?.content).toContain("稼働中のセッションはありません");
    expect(reply?.flags).toBe(64);
  });

  test("clicked outside a thread: hint only, no send-keys", async () => {
    const fx = makeInteraction({ inThread: false });
    await fx.run();

    expect(fx.compactCalls).toHaveLength(0);
    expect(fx.replies.find((r) => r.kind === "reply")?.flags).toBe(64);
  });

  test("compact failure is reported, never swallowed", async () => {
    const fx = makeInteraction({
      compactImpl: () => {
        throw new Error("tmux send-keys failed");
      },
    });
    await fx.run();

    expect(fx.compactCalls).toHaveLength(1);
    const last = fx.replies[fx.replies.length - 1];
    expect(last?.content).toContain("compact の送信に失敗");
    expect(last?.content).toContain("tmux send-keys failed");
  });
});
