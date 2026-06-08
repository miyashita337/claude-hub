import { describe, test, expect } from "bun:test";
import { runDispatch } from "../../src/session/dispatch";
import type {
  DispatchSessionManager,
  DispatchThreadFactory,
} from "../../src/session/dispatch";

/**
 * Issue #32 / S7: behavioral coverage for the dispatch orchestrator. It must
 * create the thread, start the session on the requested branch, then inject
 * `/impl <issueNumber>` via sendMessage (start does not take an initial
 * command). Failures at each stage surface (no silent fallback).
 */

function fakeManager(overrides: Partial<{
  start: (config: unknown, threadId: string, branch?: string) => Promise<unknown>;
  sendMessage: (threadId: string, message: string) => Promise<unknown>;
}> = {}): {
  manager: DispatchSessionManager;
  startCalls: Array<{ threadId: string; branch?: string }>;
  sendCalls: Array<{ threadId: string; message: string }>;
} {
  const startCalls: Array<{ threadId: string; branch?: string }> = [];
  const sendCalls: Array<{ threadId: string; message: string }> = [];
  const manager: DispatchSessionManager = {
    start:
      overrides.start ??
      (async (_config, threadId, branch) => {
        startCalls.push({ threadId, branch });
        return { id: "session-1" };
      }),
    waitForInputReady: async () => true,
    sendMessage:
      overrides.sendMessage ??
      (async (threadId, message) => {
        sendCalls.push({ threadId, message });
        return { chunks: [], text: "" };
      }),
  };
  return { manager, startCalls, sendCalls };
}

const config = { channelName: "agent-base", dir: "/x/agent-base" };

describe("runDispatch", () => {
  test("happy path: thread created, session started, /impl injected", async () => {
    const { manager, startCalls, sendCalls } = fakeManager();
    let threadBranch: string | undefined;
    const createThread: DispatchThreadFactory = async (branch) => {
      threadBranch = branch;
      return { id: "thread-abc" };
    };

    const r = await runDispatch({
      config,
      branch: "corp-dispatch-42",
      issueNumber: 42,
      command: "impl",
      sessionManager: manager,
      createThread,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.threadId).toBe("thread-abc");
      expect(r.injected).toBe("/impl 42");
    }
    expect(threadBranch).toBe("corp-dispatch-42");
    expect(startCalls).toEqual([
      { threadId: "thread-abc", branch: "corp-dispatch-42" },
    ]);
    expect(sendCalls).toEqual([
      { threadId: "thread-abc", message: "/impl 42" },
    ]);
  });

  test("start runs BEFORE the injected command (ordering)", async () => {
    const order: string[] = [];
    const { manager } = fakeManager({
      start: async () => {
        order.push("start");
        return { id: "s" };
      },
      sendMessage: async () => {
        order.push("inject");
        return {};
      },
    });
    await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(order).toEqual(["start", "inject"]);
  });

  test("thread creation failure → ok:false stage=thread, no start/inject", async () => {
    const { manager, startCalls, sendCalls } = fakeManager();
    const r = await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      createThread: async () => {
        throw new Error("missing perms");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("thread");
    expect(startCalls).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
  });

  test("session start failure → ok:false stage=start, no inject (no silent fallback)", async () => {
    const { manager, sendCalls } = fakeManager({
      start: async () => {
        throw new Error("git worktree add failed");
      },
    });
    const r = await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("start");
    expect(sendCalls).toHaveLength(0);
  });

  test("inject failure → ok:false stage=inject", async () => {
    const { manager } = fakeManager({
      sendMessage: async () => {
        throw new Error("tmux gone");
      },
    });
    const r = await runDispatch({
      config,
      branch: "b",
      issueNumber: 7,
      command: "impl",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("inject");
  });
});
