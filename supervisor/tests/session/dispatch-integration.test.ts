import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isDispatchSourceAllowed,
  loadAccessPolicy,
} from "../../src/config/access-policy";
import {
  parseDispatchCommand,
  runDispatch,
  buildDispatchFailureNotice,
} from "../../src/session/dispatch";
import type { DispatchSessionManager } from "../../src/session/dispatch";

/**
 * Issue #32 / S7: end-to-end behavioral coverage of the dispatch decision
 * sequence, replicating exactly what bot.ts's MessageCreate handler does:
 *
 *   1. isDispatchSourceAllowed(loadAccessPolicy(), channelId, sourceId)
 *   2. parseDispatchCommand(content)
 *   3. runDispatch(...)  -> start session + inject /impl <issue>
 *
 * This proves the integrated gating (auth -> parse -> run) without a live
 * Discord gateway. bot.ts's wiring (ordering + bot-author exception) is
 * additionally pinned by tests/guards/access-enforcement-wired.test.ts.
 */

const CHANNEL_ID = "846209781206941736";
const SOURCE = "555555555555555555"; // an allowed dispatch source (corp webhook/bot)
const OUTSIDER = "999999999999999999";

interface SimResult {
  outcome: "started" | "inject_failed" | "denied" | "rejected" | "ignored";
  startCalls: Array<{ threadId: string; branch?: string }>;
  sendCalls: Array<{ threadId: string; message: string }>;
  stopCalls: string[];
  /** What bot.ts would have posted into the dispatch thread (#429). */
  posts: string[];
  threadsCreated: number;
}

/**
 * Simulate the bot.ts dispatch decision for a single message. `policyChannel`
 * is the channel id present in the written policy; `channelId` is the channel
 * the message arrived on (differs to model an undefined channel).
 */
async function simulateDispatch(opts: {
  accessPath: string;
  channelId: string;
  sourceId: string;
  content: string;
  /**
   * What the relay reports for the injection (#429). Default is a healthy send;
   * `{ sendFailed: true }` is the shape `buildSendFailureResult` produces when
   * the pane never rendered the command.
   */
  sendResult?: { error?: string; sendFailed?: boolean };
}): Promise<SimResult> {
  const startCalls: Array<{ threadId: string; branch?: string }> = [];
  const sendCalls: Array<{ threadId: string; message: string }> = [];
  const stopCalls: string[] = [];
  const posts: string[] = [];
  let threadsCreated = 0;

  const manager: DispatchSessionManager = {
    start: async (_c, threadId, branch) => {
      startCalls.push({ threadId, branch });
      return { id: "s" };
    },
    waitForInputReady: async () => true,
    stop: async (threadId) => {
      stopCalls.push(threadId);
    },
    sendMessage: async (threadId, message) => {
      sendCalls.push({ threadId, message });
      return opts.sendResult ?? {};
    },
  };

  const base = { startCalls, sendCalls, stopCalls, posts, get threadsCreated() {
    return threadsCreated;
  } };

  // Step 1: authorize the source (fail-closed).
  const decision = isDispatchSourceAllowed(
    loadAccessPolicy(opts.accessPath),
    opts.channelId,
    opts.sourceId,
  );
  if (!decision.allowed) {
    return { outcome: "denied", ...base, threadsCreated };
  }

  // Step 2: parse.
  const parsed = parseDispatchCommand(opts.content);
  if (parsed.kind === "not_dispatch") {
    return { outcome: "ignored", ...base, threadsCreated };
  }
  if (parsed.kind === "error") {
    return { outcome: "rejected", ...base, threadsCreated };
  }

  // Step 3: run.
  const config = { dir: "/x", channelName: "agent-base", displayName: "Agent Base" };
  const result = await runDispatch({
    config,
    branch: parsed.branch,
    issueNumber: parsed.issueNumber,
    command: parsed.command,
    sessionManager: manager,
    createThread: async () => {
      threadsCreated += 1;
      return { id: "thread-1" };
    },
  });

  // Step 4 (#429): what bot.ts does with the result. Before #429 the failure
  // arm was a bare console.error, so a dispatch that never reached the pane
  // looked — to the thread, and therefore to corp — exactly like a successful
  // one. Mirrored here because it is the half of the contract that decides
  // whether the failure is recoverable at all.
  if (result.ok) {
    posts.push(`🛰️ **${config.displayName}** をディスパッチで起動しました`);
    return { outcome: "started", ...base, threadsCreated };
  }
  posts.push(
    buildDispatchFailureNotice(
      result.stage,
      config.displayName,
      parsed.branch,
      parsed.issueNumber,
      parsed.command,
      { sessionStopped: result.sessionStopped },
    ),
  );
  return { outcome: "inject_failed", ...base, threadsCreated };
}

describe("dispatch integration (auth -> parse -> run)", () => {
  let dir: string;
  let accessPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-int-"));
    accessPath = join(dir, "access.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePolicy(dispatchFrom: string[]): void {
    writeFileSync(
      accessPath,
      JSON.stringify({
        groups: {
          [CHANNEL_ID]: { requireMention: true, allowFrom: [], dispatchFrom },
        },
      }),
    );
  }

  test("allowed source + valid /dispatch → session started, /impl injected", async () => {
    writePolicy([SOURCE]);
    const r = await simulateDispatch({
      accessPath,
      channelId: CHANNEL_ID,
      sourceId: SOURCE,
      content: "/dispatch corp-dispatch-42 42",
    });
    expect(r.outcome).toBe("started");
    expect(r.threadsCreated).toBe(1);
    expect(r.startCalls).toEqual([{ threadId: "thread-1", branch: "corp-dispatch-42" }]);
    expect(r.sendCalls).toEqual([{ threadId: "thread-1", message: "/impl 42" }]);
  });

  test("allowed source + pdca mode → session started, /pdca injected (Epic)", async () => {
    writePolicy([SOURCE]);
    const r = await simulateDispatch({
      accessPath,
      channelId: CHANNEL_ID,
      sourceId: SOURCE,
      content: "/dispatch corp-dispatch-341 341 pdca",
    });
    expect(r.outcome).toBe("started");
    expect(r.startCalls).toEqual([{ threadId: "thread-1", branch: "corp-dispatch-341" }]);
    expect(r.sendCalls).toEqual([{ threadId: "thread-1", message: "/pdca 341" }]);
  });

  test("injection that never reached the pane → failure notice in the thread (#429)", async () => {
    // PR #434 review, question-1: the bot.ts half of #429 IS verifiable here.
    // Reaching real Discord is not, but "a failed injection produces a failure
    // notice instead of the success banner" is the part that decides whether
    // corp can recover, and it is pure decision logic.
    writePolicy([SOURCE]);
    const r = await simulateDispatch({
      accessPath,
      channelId: CHANNEL_ID,
      sourceId: SOURCE,
      content: "/dispatch corp-dispatch-429 429",
      sendResult: { error: "unverified send", sendFailed: true },
    });

    expect(r.outcome).toBe("inject_failed");
    // The session was started and then torn down (should-4), so the queue slot
    // the caller frees is genuinely free.
    expect(r.startCalls).toEqual([{ threadId: "thread-1", branch: "corp-dispatch-429" }]);
    expect(r.stopCalls).toEqual(["thread-1"]);

    expect(r.posts).toHaveLength(1);
    const notice = r.posts[0]!;
    // NOT the success banner — the regression this pins.
    expect(notice).not.toContain("ディスパッチで起動しました");
    expect(notice).toContain("失敗");
    expect(notice).toContain("/impl 429");
    // The two facts a reader needs in order to act.
    expect(notice).toMatch(/再入力/);
    expect(notice).toMatch(/再ディスパッチ/);
  });

  test("a healthy dispatch still posts the success banner, and stops nothing", async () => {
    // The counter-case: the failure arm must not fire on a good send.
    writePolicy([SOURCE]);
    const r = await simulateDispatch({
      accessPath,
      channelId: CHANNEL_ID,
      sourceId: SOURCE,
      content: "/dispatch corp-dispatch-42 42",
    });
    expect(r.outcome).toBe("started");
    expect(r.stopCalls).toEqual([]);
    expect(r.posts[0]).toContain("ディスパッチで起動しました");
  });

  test("non-allowed source → denied, no session (fail-closed)", async () => {
    writePolicy([SOURCE]);
    const r = await simulateDispatch({
      accessPath,
      channelId: CHANNEL_ID,
      sourceId: OUTSIDER,
      content: "/dispatch corp-dispatch-42 42",
    });
    expect(r.outcome).toBe("denied");
    expect(r.startCalls).toHaveLength(0);
    expect(r.sendCalls).toHaveLength(0);
    expect(r.threadsCreated).toBe(0);
  });

  test("unknown channel → denied (fail-closed), no session", async () => {
    writePolicy([SOURCE]);
    const r = await simulateDispatch({
      accessPath,
      channelId: "000000000000000000", // not in policy
      sourceId: SOURCE,
      content: "/dispatch corp-dispatch-42 42",
    });
    expect(r.outcome).toBe("denied");
    expect(r.startCalls).toHaveLength(0);
  });

  test("missing access.json → denied (fail-closed)", async () => {
    // No writePolicy() — file absent.
    const r = await simulateDispatch({
      accessPath,
      channelId: CHANNEL_ID,
      sourceId: SOURCE,
      content: "/dispatch corp-dispatch-42 42",
    });
    expect(r.outcome).toBe("denied");
    expect(r.startCalls).toHaveLength(0);
  });

  test("branch with shell metacharacters → rejected, no session (RW-045)", async () => {
    writePolicy([SOURCE]);
    const r = await simulateDispatch({
      accessPath,
      channelId: CHANNEL_ID,
      sourceId: SOURCE,
      content: "/dispatch bad$branch 42",
    });
    expect(r.outcome).toBe("rejected");
    expect(r.startCalls).toHaveLength(0);
    expect(r.threadsCreated).toBe(0);
  });

  test("non-integer issue number → rejected, no session", async () => {
    writePolicy([SOURCE]);
    const r = await simulateDispatch({
      accessPath,
      channelId: CHANNEL_ID,
      sourceId: SOURCE,
      content: "/dispatch good-branch not-a-number",
    });
    expect(r.outcome).toBe("rejected");
    expect(r.startCalls).toHaveLength(0);
  });

  test("env-allowlisted source works on a configured channel without dispatchFrom", async () => {
    // Channel configured but no dispatchFrom; the source is in env.
    writeFileSync(
      accessPath,
      JSON.stringify({
        groups: { [CHANNEL_ID]: { requireMention: true, allowFrom: [] } },
      }),
    );
    const prev = process.env.DISPATCH_ALLOWED_SOURCE_IDS;
    process.env.DISPATCH_ALLOWED_SOURCE_IDS = `${SOURCE},123`;
    try {
      const r = await simulateDispatch({
        accessPath,
        channelId: CHANNEL_ID,
        sourceId: SOURCE,
        content: "/dispatch env-branch 9",
      });
      expect(r.outcome).toBe("started");
      expect(r.sendCalls).toEqual([{ threadId: "thread-1", message: "/impl 9" }]);
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_ALLOWED_SOURCE_IDS;
      else process.env.DISPATCH_ALLOWED_SOURCE_IDS = prev;
    }
  });
});
