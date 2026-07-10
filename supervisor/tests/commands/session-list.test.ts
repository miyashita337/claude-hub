import { test, expect, describe } from "bun:test";
import type { EmbedBuilder } from "discord.js";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Handler-level tests for `/session list` (Issue #349).
 *
 * See session-stop.test.ts for the rationale (closing the same class of
 * "handler forgets to read/format state correctly" regression that Issue #349
 * was opened for, for the subcommands `/session start` and `/session resume`
 * didn't already cover). No real Discord gateway; `SessionManager` is a
 * hand-rolled fake.
 */

interface ReplyPayload {
  content?: string;
  flags?: number;
  embeds?: EmbedBuilder[];
}

function makeInteraction(opts: {
  sessions?: Array<{
    channelName: string;
    projectDir: string;
    threadId: string;
    claudeSessionId?: string;
    startedAt: Date;
    lastActivityAt: Date;
  }>;
  listImpl?: () => unknown;
}) {
  const replies: ReplyPayload[] = [];

  const interaction = {
    options: {
      getSubcommand: () => "list",
      getString: () => null,
    },
    channel: null,
    deferred: false,
    replied: false,
    async reply(msg: ReplyPayload) {
      this.replied = true;
      replies.push(msg);
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(msg: ReplyPayload) {
      replies.push(msg);
    },
  };

  const sessionManager = {
    listRunning: () => {
      if (opts.listImpl) return opts.listImpl();
      return opts.sessions ?? [];
    },
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
  };
}

describe("/session list dispatch (#349)", () => {
  test("no running sessions → ephemeral info reply, no embed", async () => {
    const h = makeInteraction({ sessions: [] });
    await h.run();

    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.flags).toBe(64); // ephemeral
    expect(h.replies[0]!.content).toContain("稼働中のセッションはありません");
    expect(h.replies[0]!.embeds).toBeUndefined();
  });

  test("running sessions → embed reply with one field per session", async () => {
    const now = new Date();
    const h = makeInteraction({
      sessions: [
        {
          channelName: "agent-base",
          projectDir: "/Users/x/agent-base",
          threadId: "thread-list-1",
          claudeSessionId: "sess-abc",
          startedAt: now,
          lastActivityAt: now,
        },
        {
          channelName: "team-salary",
          projectDir: "/Users/x/team_salary",
          threadId: "thread-list-2",
          startedAt: now,
          lastActivityAt: now,
        },
      ],
    });
    await h.run();

    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.content).toBeUndefined();
    const embeds = h.replies[0]!.embeds;
    expect(embeds).toHaveLength(1);

    const data = (embeds![0] as unknown as { data: { fields?: unknown[] } })
      .data;
    expect(data.fields).toHaveLength(2);

    const fieldValues = (data.fields as { name: string; value: string }[]).map(
      (f) => f.value
    );
    expect(fieldValues[0]).toContain("/Users/x/agent-base");
    expect(fieldValues[0]).toContain("sess-abc");
    expect(fieldValues[1]).toContain("/Users/x/team_salary");
    // No claudeSessionId on the second session → no "🔑 Session:" line.
    expect(fieldValues[1]).not.toContain("🔑 Session:");
  });

  test("listRunning() throws → error surfaced, no crash", async () => {
    const h = makeInteraction({
      listImpl: () => {
        throw new Error("db read failed");
      },
    });
    await h.run();

    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.content).toContain("セッション一覧の取得に失敗");
  });
});
