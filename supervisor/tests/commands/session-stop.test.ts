import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
 *
 * Issue #366: `/session stop` terminates a running
 * `--dangerously-skip-permissions` session, so it now runs behind the same
 * access.json `allowFrom` gate as `/session start` / `/session enter` /
 * `/session compact`, keyed on the parent channel (fail-closed).
 */

const PARENT_CHANNEL_ID = "846209781206941736";
const OWNER = "184695080709324800";
const OUTSIDER = "999999999999999999";

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

function makeInteraction(opts: {
  isThread?: boolean;
  hasSession?: boolean;
  stopImpl?: (...args: unknown[]) => unknown;
  /** Thread title; defaults to a Supervisor-created one (status emoji). */
  threadName?: string;
  /** override the thread's parent channel id (default PARENT_CHANNEL_ID). */
  parentId?: string | null;
  /** invoking user id (default OWNER). */
  userId?: string;
}) {
  const replies: ReplyRecord[] = [];
  const stopCalls: unknown[][] = [];
  const setNameCalls: string[] = [];
  const setArchivedCalls: boolean[] = [];

  const channel = {
    id: "thread-stop-1",
    parentId: opts.parentId !== undefined ? opts.parentId : PARENT_CHANNEL_ID,
    name: opts.threadName ?? "🟢 feature-foo | agent-base",
    isThread: () => opts.isThread ?? true,
    setName: async (name: string) => {
      setNameCalls.push(name);
    },
    setArchived: async (archived: boolean) => {
      setArchivedCalls.push(archived);
    },
  };

  const interaction = {
    user: { id: opts.userId ?? OWNER },
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
  let dir: string;
  const prevAccess = process.env.SUPERVISOR_ACCESS_JSON_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-stop-access-"));
    const path = join(dir, "access.json");
    writeFileSync(
      path,
      JSON.stringify({
        groups: {
          [PARENT_CHANNEL_ID]: { requireMention: true, allowFrom: [OWNER] },
        },
      })
    );
    process.env.SUPERVISOR_ACCESS_JSON_PATH = path;
  });

  afterEach(() => {
    if (prevAccess === undefined)
      delete process.env.SUPERVISOR_ACCESS_JSON_PATH;
    else process.env.SUPERVISOR_ACCESS_JSON_PATH = prevAccess;
    rmSync(dir, { recursive: true, force: true });
  });

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

  test("#453: a bound thread with no status emoji is archived but not renamed", async () => {
    // A thread the Supervisor bound to (rather than created) keeps its own
    // title, so markTitleStopped has nothing to swap. Renaming it to the same
    // value would burn one of Discord's scarce thread-rename slots for nothing.
    const h = makeInteraction({
      isThread: true,
      hasSession: true,
      threadName: "決裁: 朝レポ 2026-08-24",
    });
    await h.run();

    expect(h.setNameCalls).toHaveLength(0);
    expect(h.setArchivedCalls).toEqual([true]);
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

  test("#366: a user outside allowFrom is refused, stop() never called, thread not archived", async () => {
    const h = makeInteraction({ userId: OUTSIDER });
    await h.run();

    expect(h.stopCalls).toHaveLength(0);
    expect(h.setNameCalls).toHaveLength(0);
    expect(h.setArchivedCalls).toHaveLength(0);
    const deny = h.replies.find((r) => r.kind === "reply");
    expect(deny?.content).toContain("権限がありません");
    expect(deny?.flags).toBe(64);
  });

  test("#366: fail-closed when access.json is missing", async () => {
    rmSync(join(dir, "access.json"));
    const h = makeInteraction({});
    await h.run();

    expect(h.stopCalls).toHaveLength(0);
    const deny = h.replies.find((r) => r.kind === "reply");
    expect(deny?.content).toContain("権限がありません");
  });
});
