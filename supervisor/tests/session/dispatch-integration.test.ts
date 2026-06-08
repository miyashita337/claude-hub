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
  outcome: "started" | "denied" | "rejected" | "ignored";
  startCalls: Array<{ threadId: string; branch?: string }>;
  sendCalls: Array<{ threadId: string; message: string }>;
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
}): Promise<SimResult> {
  const startCalls: Array<{ threadId: string; branch?: string }> = [];
  const sendCalls: Array<{ threadId: string; message: string }> = [];
  let threadsCreated = 0;

  const manager: DispatchSessionManager = {
    start: async (_c, threadId, branch) => {
      startCalls.push({ threadId, branch });
      return { id: "s" };
    },
    waitForInputReady: async () => true,
    sendMessage: async (threadId, message) => {
      sendCalls.push({ threadId, message });
      return {};
    },
  };

  const base = { startCalls, sendCalls, get threadsCreated() {
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
  await runDispatch({
    config: { dir: "/x", channelName: "agent-base", displayName: "Agent Base" },
    branch: parsed.branch,
    issueNumber: parsed.issueNumber,
    command: parsed.command,
    sessionManager: manager,
    createThread: async () => {
      threadsCreated += 1;
      return { id: "thread-1" };
    },
  });
  return { outcome: "started", ...base, threadsCreated };
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
