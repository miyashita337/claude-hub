import { test, expect, describe } from "bun:test";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Handler-level tests for `/session stop` (Issue #349).
 *
 * Issue #349's trigger was a Discord slash command handler regression
 * (`/session start <branch>` silently forgetting to read the `branch` option)
 * that shipped without a CI-executable E2E to catch it. `/session start` and
 * `/session resume` already had handler-level dispatch coverage
 * (session-start-branch.test.ts / session-resume.test.ts, Issue #154 / #161).
 * `/session stop` had none — this file closes that gap using the same
 * mock-`ChatInputCommandInteraction` approach (no real Discord gateway, no
 * real tmux; `SessionManager` is a hand-rolled fake so no process is spawned).
 */

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

function makeInteraction(opts: {
  isThread?: boolean;
  hasSession?: boolean;
  stopImpl?: (...args: unknown[]) => unknown;
}) {
  const replies: ReplyRecord[] = [];
  const stopCalls: unknown[][] = [];
  const setNameCalls: string[] = [];
  const setArchivedCalls: boolean[] = [];

  const channel = {
    id: "thread-stop-1",
    name: "🟢 feature-foo | agent-base",
    isThread: () => opts.isThread ?? true,
    setName: async (name: string) => {
      setNameCalls.push(name);
    },
    setArchived: async (archived: boolean) => {
      setArchivedCalls.push(archived);
    },
  };

  const interaction = {
    options: {
      getSubcommand: () => "stop",
      getString: () => null,
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
    has: (_threadId: string) => opts.hasSession ?? true,
    stop: async (...args: unknown[]) => {
      stopCalls.push(args);
      return opts.stopImpl?.(...args);
    },
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
    stopCalls,
    setNameCalls,
    setArchivedCalls,
  };
}

describe("/session stop dispatch (#349)", () => {
  test("outside a thread → usage hint, stop() never called", async () => {
    const h = makeInteraction({ isThread: false });
    await h.run();

    expect(h.stopCalls).toHaveLength(0);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.kind).toBe("reply");
    expect(h.replies[0]!.flags).toBe(64); // ephemeral
    expect(h.replies[0]!.content).toContain("セッションスレッド内で実行");
  });

  test("in a thread with no tracked session → info reply, stop() never called", async () => {
    const h = makeInteraction({ isThread: true, hasSession: false });
    await h.run();

    expect(h.stopCalls).toHaveLength(0);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.content).toContain("稼働中のセッションはありません");
  });

  test("active session → stop() called with (threadId, \"manual\"), thread archived", async () => {
    const h = makeInteraction({ isThread: true, hasSession: true });
    await h.run();

    expect(h.stopCalls).toHaveLength(1);
    expect(h.stopCalls[0]).toEqual(["thread-stop-1", "manual"]);
    expect(h.setNameCalls).toHaveLength(1);
    expect(h.setArchivedCalls).toEqual([true]);

    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies).toHaveLength(1);
    expect(editReplies[0]!.content).toContain("停止しました");
  });

  test("stop() failure → error surfaced, thread not renamed/archived", async () => {
    const h = makeInteraction({
      isThread: true,
      hasSession: true,
      stopImpl: () => {
        throw new Error("tmux kill-session failed");
      },
    });
    await h.run();

    expect(h.stopCalls).toHaveLength(1);
    expect(h.setNameCalls).toHaveLength(0);
    expect(h.setArchivedCalls).toHaveLength(0);

    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies.length).toBeGreaterThan(0);
    expect(editReplies[editReplies.length - 1]!.content).toContain(
      "セッション停止に失敗"
    );
  });
});
