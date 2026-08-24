import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Handler-level tests for Issue #453: `/session start <branch>` run INSIDE a
 * thread binds the session to that thread instead of opening a sibling one.
 *
 * The motivating case is a thread the Supervisor did not create — a corp
 * decision thread opened by a bot (#449) — which previously had no way to gain
 * a resident session, so `@Supervisor` there only ever answered "このスレッドには
 * セッション履歴がありません".
 *
 * Access is enforced before any of this (Issue #32), so these tests point the
 * policy loader at a temp file that allows the fixture user on the fixture
 * PARENT channel id (threads inherit their parent's opt-in).
 */

const FIXTURE_PARENT_CHANNEL_ID = "fixture-parent-channel";
const FIXTURE_USER_ID = "fixture-user";
const EXISTING_THREAD_ID = "existing-bot-thread";

let accessDir: string;
const prevAccessPath = process.env.SUPERVISOR_ACCESS_JSON_PATH;

beforeEach(() => {
  accessDir = mkdtempSync(join(tmpdir(), "session-start-in-thread-access-"));
  const accessPath = join(accessDir, "access.json");
  writeFileSync(
    accessPath,
    JSON.stringify({
      groups: {
        [FIXTURE_PARENT_CHANNEL_ID]: {
          requireMention: true,
          allowFrom: [FIXTURE_USER_ID],
        },
      },
    }),
  );
  process.env.SUPERVISOR_ACCESS_JSON_PATH = accessPath;
});

afterEach(() => {
  if (prevAccessPath === undefined)
    delete process.env.SUPERVISOR_ACCESS_JSON_PATH;
  else process.env.SUPERVISOR_ACCESS_JSON_PATH = prevAccessPath;
  rmSync(accessDir, { recursive: true, force: true });
});

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
}

function makeInteraction(opts: {
  /** Invoke from inside a thread (default) or from the parent channel. */
  inThread?: boolean;
  /** Whether the invoking thread already has a live tracked session. */
  hasSession?: boolean;
  /** Whether the invoking thread is archived. */
  archived?: boolean;
  /** Make SessionManager.start fail, to exercise the cleanup path. */
  startFails?: boolean;
}) {
  const inThread = opts.inThread ?? true;
  const replies: ReplyRecord[] = [];
  const startCalls: unknown[][] = [];
  const setArchivedCalls: boolean[] = [];
  const existingThreadSends: string[] = [];
  const newThreadSends: string[] = [];
  let threadCreated = false;
  let createdThreadDeleted = false;
  let existingThreadDeleted = false;

  const newThread = {
    id: "newly-created-thread",
    send: async (m: string) => {
      newThreadSends.push(m);
    },
    delete: async () => {
      createdThreadDeleted = true;
    },
  };

  const parentChannel = {
    id: FIXTURE_PARENT_CHANNEL_ID,
    name: "agent-base",
    isThread: () => false,
    isTextBased: () => true,
    isDMBased: () => false,
    threads: {
      create: async () => {
        threadCreated = true;
        return newThread;
      },
    },
  };

  const threadChannel = {
    id: EXISTING_THREAD_ID,
    parentId: FIXTURE_PARENT_CHANNEL_ID,
    parent: parentChannel,
    isThread: () => true,
    archived: opts.archived ?? false,
    setArchived: async (value: boolean) => {
      setArchivedCalls.push(value);
    },
    send: async (m: string) => {
      existingThreadSends.push(m);
    },
    delete: async () => {
      existingThreadDeleted = true;
    },
  };

  const channel = inThread ? threadChannel : parentChannel;

  const interaction = {
    user: { id: FIXTURE_USER_ID },
    options: {
      getSubcommand: () => "start",
      getString: (name: string) => (name === "branch" ? "feature-foo" : null),
    },
    channel,
    deferred: false,
    replied: false,
    async reply(msg: { content?: string }) {
      this.replied = true;
      replies.push({ kind: "reply", content: msg.content });
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
    listRunning: () => [],
    listRunningByChannel: () => [],
    has: (threadId: string) =>
      (opts.hasSession ?? false) && threadId === EXISTING_THREAD_ID,
    start: (...args: unknown[]) => {
      startCalls.push(args);
      if (opts.startFails) throw new Error("worktree 作成に失敗");
      return {
        worktree: {
          mainRepoDir: "/Users/x/agent-base",
          path: "/Users/x/agent-base/.claude/worktrees/feature-foo",
          branch: "feature-foo",
        },
      };
    },
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
    startCalls,
    setArchivedCalls,
    existingThreadSends,
    newThreadSends,
    get threadCreated() {
      return threadCreated;
    },
    get createdThreadDeleted() {
      return createdThreadDeleted;
    },
    get existingThreadDeleted() {
      return existingThreadDeleted;
    },
  };
}

describe("/session start inside a thread (Issue #453)", () => {
  test("AC-1: binds to the invoking thread instead of creating a new one", async () => {
    const h = makeInteraction({ inThread: true, hasSession: false });
    await h.run();

    expect(h.threadCreated).toBe(false);
    expect(h.startCalls.length).toBe(1);
    // start(config, threadId, branch, model) — the thread we were invoked in.
    expect(h.startCalls[0]![1]).toBe(EXISTING_THREAD_ID);
    expect(h.startCalls[0]![2]).toBe("feature-foo");

    // Welcome message lands in the same thread, and says it bound here.
    expect(h.existingThreadSends.length).toBe(1);
    expect(h.existingThreadSends[0]).toContain("このスレッドに接続しました");
    expect(h.newThreadSends.length).toBe(0);

    const last = h.replies.at(-1)!;
    expect(last.kind).toBe("editReply");
    expect(last.content).toContain("このスレッドにセッションを接続しました");
  });

  test("AC-3: from the parent channel it still creates a new thread", async () => {
    const h = makeInteraction({ inThread: false });
    await h.run();

    expect(h.threadCreated).toBe(true);
    expect(h.startCalls[0]![1]).toBe("newly-created-thread");
    expect(h.newThreadSends[0]).toContain("セッションを開始しました");
    expect(h.replies.at(-1)!.content).toContain("セッションをスレッドで起動しました");
  });

  test("a thread that already has a live session keeps creating a sibling thread", async () => {
    const h = makeInteraction({ inThread: true, hasSession: true });
    await h.run();

    expect(h.threadCreated).toBe(true);
    expect(h.startCalls[0]![1]).toBe("newly-created-thread");
    expect(h.existingThreadSends.length).toBe(0);
  });

  test("an archived thread is unarchived before the session's first message", async () => {
    const h = makeInteraction({ inThread: true, archived: true });
    await h.run();

    expect(h.setArchivedCalls).toEqual([false]);
    expect(h.existingThreadSends.length).toBe(1);
  });

  test("a failed start never deletes the thread it merely bound to", async () => {
    const h = makeInteraction({ inThread: true, startFails: true });
    await h.run();

    expect(h.existingThreadDeleted).toBe(false);
    expect(h.createdThreadDeleted).toBe(false);
    expect(h.replies.at(-1)!.content).toContain("セッション起動に失敗");
  });

  test("a failed start still deletes the thread it created (unchanged)", async () => {
    const h = makeInteraction({ inThread: false, startFails: true });
    await h.run();

    expect(h.createdThreadDeleted).toBe(true);
    expect(h.replies.at(-1)!.content).toContain("セッション起動に失敗");
  });
});
