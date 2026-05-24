import { test, expect, describe } from "bun:test";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Handler-level tests for the `/session start <branch>` migration (Issue #154).
 *
 * These build a minimal fake ChatInputCommandInteraction so we exercise the
 * real handler logic without a Discord gateway. Focus:
 *   - AC-4: a missing/empty branch is rejected before any thread or session is
 *     created, with the migration hint.
 *   - the branch value is forwarded to SessionManager.start.
 */

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

function makeInteraction(opts: {
  branch?: string | null;
  channelName?: string;
  onThreadCreate?: () => void;
  startImpl?: (...args: unknown[]) => unknown;
}) {
  const replies: ReplyRecord[] = [];
  const startCalls: unknown[][] = [];
  let threadCreated = false;

  let threadDeleted = false;
  const thread = {
    id: "thread-xyz",
    send: async () => {},
    delete: async () => {
      threadDeleted = true;
    },
  };

  const channel = {
    isThread: () => false,
    isTextBased: () => true,
    isDMBased: () => false,
    name: opts.channelName ?? "agent-base",
    threads: {
      create: async () => {
        threadCreated = true;
        opts.onThreadCreate?.();
        return thread;
      },
    },
  };

  const interaction = {
    options: {
      getSubcommand: () => "start",
      getString: (name: string) =>
        name === "branch" ? opts.branch ?? null : null,
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
    start: (...args: unknown[]) => {
      startCalls.push(args);
      return (
        opts.startImpl?.(...args) ?? {
          worktree: {
            mainRepoDir: "/Users/x/agent-base",
            path: "/Users/x/agent-base/.claude/worktrees/feature-foo",
            branch: "feature-foo",
          },
        }
      );
    },
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
    startCalls,
    get threadCreated() {
      return threadCreated;
    },
    get threadDeleted() {
      return threadDeleted;
    },
  };
}

describe("/session start branch validation (#154)", () => {
  test("AC-4: no branch → ephemeral migration error, no thread, no session", async () => {
    const h = makeInteraction({ branch: null });
    await h.run();

    expect(h.startCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.kind).toBe("reply");
    expect(h.replies[0]!.flags).toBe(64); // ephemeral
    expect(h.replies[0]!.content).toContain("branch 引数が必須");
    expect(h.replies[0]!.content).toContain("/session start <branch-name>");
  });

  test("AC-4: whitespace-only branch is also rejected", async () => {
    const h = makeInteraction({ branch: "   " });
    await h.run();
    expect(h.startCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
  });

  test("forwards the trimmed branch to SessionManager.start", async () => {
    const h = makeInteraction({ branch: "  feature-foo  " });
    await h.run();

    expect(h.startCalls).toHaveLength(1);
    // start(config, threadId, branch)
    expect(h.startCalls[0]![2]).toBe("feature-foo");
    expect(h.threadCreated).toBe(true);
  });

  test("deletes the orphan thread and reports the error when start fails", async () => {
    const h = makeInteraction({
      branch: "feature-foo",
      startImpl: () => {
        throw new Error("git worktree add failed");
      },
    });
    await h.run();

    // Orphan thread cleaned up (no dead "🟢 Session" thread left behind).
    expect(h.threadCreated).toBe(true);
    expect(h.threadDeleted).toBe(true);

    // Error surfaced to the user via the deferred editReply path.
    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies.length).toBeGreaterThan(0);
    expect(editReplies[editReplies.length - 1]!.content).toContain(
      "セッション起動に失敗"
    );
  });
});
