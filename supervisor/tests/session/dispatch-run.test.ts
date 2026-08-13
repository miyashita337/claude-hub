import { describe, test, expect } from "bun:test";
import { runDispatch, buildDispatchFailureNotice } from "../../src/session/dispatch";
import type {
  DispatchSessionManager,
  DispatchThreadFactory,
  DispatchSendResult,
} from "../../src/session/dispatch";
import type { DialogStuckInfo } from "../../src/session/dialog-stuck-handler";

/**
 * Issue #32 / S7: behavioral coverage for the dispatch orchestrator. It must
 * create the thread, start the session on the requested branch, then inject
 * `/impl <issueNumber>` via sendMessage (start does not take an initial
 * command). Failures at each stage surface (no silent fallback).
 */

function fakeManager(overrides: Partial<{
  start: (config: unknown, threadId: string, branch?: string) => Promise<unknown>;
  sendMessage: (threadId: string, message: string) => Promise<DispatchSendResult>;
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
        // A healthy relay: a result with no `sendFailed` (#429).
        return {};
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

/**
 * Issue #429: the injection is the one send in the whole system that #428 left
 * unverified, and it is the send corp's silent stalls actually happen on.
 *
 * The trap this locks is that a failed send does NOT throw: `relayMessage`
 * converts it into a RESULT (a user-facing chunk plus `error`), so the
 * `try/catch` around `sendMessage` sees nothing and the dispatch used to report
 * `ok: true` — thread banner, ledger `dispatched`, session idle forever.
 */
describe("runDispatch — an injection that never reached the pane is a failure (#429)", () => {
  test("sendFailed result → ok:false stage=inject (not a cheerful ok:true)", async () => {
    const { manager } = fakeManager({
      // Exactly what buildSendFailureResult produces: resolves, does not throw.
      sendMessage: async () => ({
        error: "Error: send-keys was accepted but the text never appeared in the pane (#422)",
        sendFailed: true,
      }),
    });
    const r = await runDispatch({
      config,
      branch: "corp-dispatch-429",
      issueNumber: 429,
      command: "impl",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("inject");
      // The cause is carried for the log (the user-facing text is built
      // separately by buildDispatchFailureNotice, without this string).
      expect(r.error).toContain("#422");
    }
  });

  test("a relay timeout is NOT a dispatch failure — the command did land", async () => {
    // The counter-case that keeps this from over-reporting: `/pdca 429` runs for
    // hours, so the relay wait expires long before the job does. `error` is set,
    // but the pane DID receive the command. Failing here would swap a silent
    // drop for a false alarm on every long-running dispatch.
    const { manager } = fakeManager({
      sendMessage: async () => ({ error: "relay timeout after 900000ms" }),
    });
    const r = await runDispatch({
      config,
      branch: "corp-dispatch-429",
      issueNumber: 429,
      command: "pdca",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.injected).toBe("/pdca 429");
  });
});

/**
 * Issue #429: before this, a failed dispatch reached `console.error` and nothing
 * else — corp's ledger stayed `dispatched` and the thread stayed empty, so the
 * failure was indistinguishable from a session still working. The notice is what
 * makes the existing recovery path (corp#107 / #108 re-injection) reachable.
 */
describe("buildDispatchFailureNotice (#429)", () => {
  const notice = (stage: Parameters<typeof buildDispatchFailureNotice>[0]) =>
    buildDispatchFailureNotice(stage, "agent-base", "corp-dispatch-429", 429, "impl");

  test("names what failed and what was going to run", () => {
    const msg = notice("inject");
    expect(msg).toContain("agent-base");
    expect(msg).toContain("corp-dispatch-429");
    expect(msg).toContain("/impl 429");
    // Unambiguously a failure — the old path posted the SUCCESS banner here.
    expect(msg).toContain("失敗");
  });

  test("the inject notice states that nothing was re-sent automatically", () => {
    // The single most important sentence in this PR: someone reading the thread
    // has to know the session is idle, not working, and that no retype happened.
    const msg = notice("inject");
    expect(msg).toMatch(/再入力/);
    expect(msg).toMatch(/Enter/);
    expect(msg).toMatch(/再ディスパッチ/);
  });

  test("every stage produces its own non-empty explanation", () => {
    const stages = ["thread", "start", "inject", "output"] as const;
    const bodies = stages.map((s) => notice(s));
    // No stage silently falls through to a generic blob.
    expect(new Set(bodies).size).toBe(stages.length);
    for (const body of bodies) expect(body.length).toBeGreaterThan(40);
  });

  test("carries no tmux/exec internals into Discord", () => {
    // Same contract as SEND_FAILURE_USER_MESSAGE (Issue #74): the raw cause —
    // `not in a mode`, an ETIMEDOUT, an absolute path from an fs error — stays
    // in the Supervisor log. The builder takes no `error` argument at all, so
    // this is structural; the assertions lock the wording that remains.
    for (const stage of ["thread", "start", "inject", "output"] as const) {
      const msg = notice(stage);
      expect(msg).not.toMatch(/send-keys|capture-pane|not in a mode|ETIMEDOUT|\/Users\//);
    }
  });
});

/**
 * PR #431 review, should-4. #423 stopped the watchdog from answering an
 * AskUserQuestion on the user's behalf, which turns a fabricated answer into a
 * stalled session — an improvement only if somebody is told. The dispatch path
 * passed no `onDialogStuck`, so for the sessions with nobody watching the pane
 * the news stopped at `console.warn`. That is #304's "詰む" state again, and it
 * is reachable without any expiry notice firing: if POST /ask is refused or
 * answers 503, no ask is ever registered, so nothing expires.
 */
describe("runDispatch — a dialog needing a human reaches the thread (#423 / #431 should-4)", () => {
  test("forwards an onDialogStuck that posts the heartbeat into the dispatch thread", async () => {
    let received:
      | { onDialogStuck?: (info: DialogStuckInfo) => void | Promise<void> }
      | undefined;
    const manager: DispatchSessionManager = {
      start: async () => ({ id: "session-1" }),
      waitForInputReady: async () => true,
      sendMessage: async (_threadId, _message, _attachments, options) => {
        received = options;
        return {};
      },
    };
    const posted: Array<{ threadId: string; content: string }> = [];

    const r = await runDispatch({
      config,
      branch: "corp-dispatch-42",
      issueNumber: 42,
      command: "impl",
      sessionManager: manager,
      createThread: async () => ({ id: "thread-abc" }),
      postToThread: async (threadId, content) => {
        posted.push({ threadId, content });
      },
    });

    expect(r.ok).toBe(true);
    expect(received?.onDialogStuck).toBeTypeOf("function");

    // Drive it the way the watchdog would and assert it lands in the thread —
    // asserting only that a callback was passed would not prove it is wired to
    // anything the user can see.
    await received!.onDialogStuck!({
      kind: "ask-user-question",
      line: "4. Type something.",
      tmuxSessionName: "claude-abc123",
    });

    expect(posted.length).toBe(1);
    expect(posted[0]!.threadId).toBe("thread-abc");
    expect(posted[0]!.content).toContain("質問");
    expect(posted[0]!.content).toContain("自動では選ばれません");
  });

  test("without a poster the dispatch still runs, and says so instead of failing silently", async () => {
    const { manager, sendCalls } = fakeManager();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      const r = await runDispatch({
        config,
        branch: "corp-dispatch-42",
        issueNumber: 42,
        command: "impl",
        sessionManager: manager,
        createThread: async () => ({ id: "thread-abc" }),
      });
      expect(r.ok).toBe(true);
      expect(sendCalls.length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("no postToThread"))).toBe(true);
  });
});
