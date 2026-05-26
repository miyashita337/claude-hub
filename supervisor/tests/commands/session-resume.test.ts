import { test, expect, describe } from "bun:test";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Handler-level tests for `/session resume <session_id>` (Issue #161).
 *
 * Mirrors session-start-branch.test.ts: a minimal fake
 * ChatInputCommandInteraction exercises the real handler without a Discord
 * gateway. `findResumableSession` is stubbed on the fake SessionManager so the
 * handler's validation branches are covered without a real DB.
 *
 * "team-salary" is a real CHANNEL_MAP key, so the channel-registration gate
 * passes; "claude-hub-hijoguchi" is intentionally NOT in CHANNEL_MAP.
 */

const VALID_ID = "3139aa23-fe2a-485a-831a-2209081f9935";

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

interface ResumableRow {
  channel_name: string;
  project_dir: string;
  status: string;
}

function makeInteraction(opts: {
  sessionId?: string | null;
  channelName?: string;
  resumableRow?: ResumableRow | undefined;
  resumeImpl?: (...args: unknown[]) => unknown;
}) {
  const replies: ReplyRecord[] = [];
  const resumeCalls: unknown[][] = [];
  const findCalls: string[] = [];
  let threadCreated = false;
  let threadDeleted = false;

  const thread = {
    id: "thread-resume-1",
    send: async () => {},
    delete: async () => {
      threadDeleted = true;
    },
  };

  const channel = {
    isThread: () => false,
    isTextBased: () => true,
    isDMBased: () => false,
    name: opts.channelName ?? "team-salary",
    threads: {
      create: async () => {
        threadCreated = true;
        return thread;
      },
    },
  };

  const interaction = {
    options: {
      getSubcommand: () => "resume",
      getString: (name: string) =>
        name === "session_id" ? opts.sessionId ?? null : null,
    },
    channel,
    deferred: false,
    replied: false,
    async reply(msg: { content?: string; flags?: number }) {
      this.replied = true;
      replies.push({ kind: "reply", content: msg.content, flags: msg.flags });
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(msg: { content?: string }) {
      replies.push({ kind: "editReply", content: msg.content });
    },
  };

  const sessionManager = {
    count: () => 0,
    listRunningByChannel: () => [],
    findResumableSession: (id: string) => {
      findCalls.push(id);
      return opts.resumableRow;
    },
    resumeSession: (...args: unknown[]) => {
      resumeCalls.push(args);
      return opts.resumeImpl?.(...args) ?? { id: "sess-1" };
    },
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
    resumeCalls,
    findCalls,
    get threadCreated() {
      return threadCreated;
    },
    get threadDeleted() {
      return threadDeleted;
    },
  };
}

describe("/session resume validation (#161)", () => {
  test("no session_id → ephemeral usage error, no resume, no thread", async () => {
    const h = makeInteraction({ sessionId: null });
    await h.run();

    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.flags).toBe(64);
    expect(h.replies[0]!.content).toContain("session_id が必須");
  });

  test("whitespace-only session_id is also rejected", async () => {
    const h = makeInteraction({ sessionId: "   " });
    await h.run();
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
  });

  test("unregistered channel → 未登録 error, no DB lookup", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "claude-hub-hijoguchi",
    });
    await h.run();
    expect(h.findCalls).toHaveLength(0);
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.replies[0]!.content).toContain("未登録");
  });

  test("session_id not found → error, no thread", async () => {
    const h = makeInteraction({ sessionId: VALID_ID, resumableRow: undefined });
    await h.run();
    expect(h.findCalls).toEqual([VALID_ID]);
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies[0]!.content).toContain("見つかりません");
  });

  test("session from a different channel → error", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "agent-base",
        project_dir: "/Users/x/agent-base",
        status: "stopped",
      },
    });
    await h.run();
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.replies[0]!.content).toContain("別チャンネル");
    expect(h.replies[0]!.content).toContain("agent-base");
  });

  test("session already running → warns, no resume", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "team-salary",
        project_dir: "/Users/x/team_salary",
        status: "running",
      },
    });
    await h.run();
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.replies[0]!.content).toContain("既に稼働中");
  });

  test("valid stopped session → resumeSession called with project_dir, thread created", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "team-salary",
        project_dir: "/Users/x/team_salary",
        status: "stopped",
      },
    });
    await h.run();

    expect(h.threadCreated).toBe(true);
    expect(h.resumeCalls).toHaveLength(1);
    // resumeSession(config, threadId, sessionId, projectDir)
    expect(h.resumeCalls[0]![1]).toBe("thread-resume-1");
    expect(h.resumeCalls[0]![2]).toBe(VALID_ID);
    expect(h.resumeCalls[0]![3]).toBe("/Users/x/team_salary");

    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies[editReplies.length - 1]!.content).toContain("復帰しました");
  });

  test("resume failure → orphan thread deleted + error surfaced", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "team-salary",
        project_dir: "/Users/x/team_salary",
        status: "stopped",
      },
      resumeImpl: () => {
        throw new Error("プロジェクトディレクトリが見つかりません");
      },
    });
    await h.run();

    expect(h.threadCreated).toBe(true);
    expect(h.threadDeleted).toBe(true);
    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies[editReplies.length - 1]!.content).toContain(
      "セッション復帰に失敗"
    );
  });
});
