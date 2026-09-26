import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createSessionHandler,
  DEFAULT_COMPACT_INTENT,
} from "../../src/commands/session";

/**
 * Handler-level tests for `/session compact [intent]` (Issue #200).
 *
 * Mirrors session-resume.test.ts: a minimal fake ChatInputCommandInteraction
 * exercises the real handler without a Discord gateway. The fake SessionManager
 * records `has` lookups and `compactSession` calls so we can assert the
 * resolution branches, the never-bare-/compact contract (RW-032), and that no
 * keys are sent when there is no session to compact.
 *
 * Issue #366: `/session compact` sends keys into a running
 * `--dangerously-skip-permissions` session exactly like `/session start` and
 * `/session enter` do, so every fixture now runs behind an access.json
 * `allowFrom` gate keyed on the parent channel (fail-closed).
 */

const PARENT_CHANNEL_ID = "846209781206941736";
const PRIMARY_CHANNEL_ID = "primary-chan-199";
const OWNER = "184695080709324800";
const OUTSIDER = "999999999999999999";

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

function makeInteraction(opts: {
  intent?: string | null;
  /** false → invoked outside a thread (channel context). */
  inThread?: boolean;
  /** whether the thread has a running session (sessionManager.has). */
  hasSession?: boolean;
  /** make compactSession reject, to exercise the error branch. */
  compactImpl?: (threadId: string, intent: string) => unknown;
  /** override the channel id (default "thread-compact-1"). */
  channelId?: string;
  /** override the thread's parent channel id (default PARENT_CHANNEL_ID when inThread). */
  parentId?: string | null;
  /** invoking user id (default OWNER). */
  userId?: string;
  /** make compactPrimarySession reject, to exercise the error branch (#199 AC1). */
  primaryCompactImpl?: (intent: string) => unknown;
}) {
  const replies: ReplyRecord[] = [];
  const compactCalls: { threadId: string; intent: string }[] = [];
  const primaryCompactCalls: { intent: string }[] = [];
  const hasCalls: string[] = [];

  const inThread = opts.inThread ?? true;
  const channel = {
    id: opts.channelId ?? "thread-compact-1",
    parentId:
      opts.parentId !== undefined
        ? opts.parentId
        : inThread
          ? PARENT_CHANNEL_ID
          : null,
    isThread: () => inThread,
  };

  const interaction = {
    user: { id: opts.userId ?? OWNER },
    options: {
      getSubcommand: () => "compact",
      getString: (name: string) =>
        name === "intent" ? opts.intent ?? null : null,
    },
    channel,
    deferred: false,
    replied: false,
    async reply(msg: { content?: string; flags?: number }) {
      this.replied = true;
      replies.push({ kind: "reply", content: msg.content, flags: msg.flags });
    },
    async deferReply(msg?: { flags?: number }) {
      this.deferred = true;
      // flags captured so we can assert the ack is ephemeral.
      replies.push({ kind: "reply", flags: msg?.flags });
    },
    async editReply(msg: { content?: string }) {
      replies.push({ kind: "editReply", content: msg.content });
    },
  };

  const sessionManager = {
    has: (threadId: string) => {
      hasCalls.push(threadId);
      return opts.hasSession ?? true;
    },
    compactSession: async (threadId: string, intent: string) => {
      compactCalls.push({ threadId, intent });
      return opts.compactImpl?.(threadId, intent);
    },
    compactPrimarySession: async (intent: string) => {
      primaryCompactCalls.push({ intent });
      return opts.primaryCompactImpl?.(intent);
    },
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
    compactCalls,
    primaryCompactCalls,
    hasCalls,
  };
}

describe("/session compact (#200)", () => {
  let dir: string;
  const prevAccess = process.env.SUPERVISOR_ACCESS_JSON_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-compact-access-"));
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

  test("running session + explicit intent: relays /compact <intent>, ephemeral ack", async () => {
    const fx = makeInteraction({ intent: "直近のリファクタと残テストを保持" });
    await fx.run();

    expect(fx.compactCalls).toHaveLength(1);
    expect(fx.compactCalls[0]).toEqual({
      threadId: "thread-compact-1",
      intent: "直近のリファクタと残テストを保持",
    });
    // Ack must be ephemeral (flags 64) and confirm the sent text.
    expect(fx.replies.some((r) => r.flags === 64)).toBe(true);
    const ack = fx.replies.find((r) => r.kind === "editReply");
    expect(ack?.content).toContain("/compact 直近のリファクタと残テストを保持");
  });

  test("intent omitted: never sends a bare /compact, substitutes the default (RW-032)", async () => {
    const fx = makeInteraction({ intent: null });
    await fx.run();

    expect(fx.compactCalls).toHaveLength(1);
    expect(fx.compactCalls[0]?.intent).toBe(DEFAULT_COMPACT_INTENT);
  });

  test("whitespace-only intent is treated as omitted (default substituted)", async () => {
    const fx = makeInteraction({ intent: "   " });
    await fx.run();

    expect(fx.compactCalls[0]?.intent).toBe(DEFAULT_COMPACT_INTENT);
  });

  test("no session in thread: usage hint, no send-keys (AC-3)", async () => {
    const fx = makeInteraction({ hasSession: false });
    await fx.run();

    expect(fx.compactCalls).toHaveLength(0);
    const hint = fx.replies.find((r) => r.kind === "reply");
    expect(hint?.content).toContain("稼働中のセッションはありません");
    expect(hint?.flags).toBe(64);
  });

  test("invoked outside a thread: usage hint, no send-keys, no has() lookup (AC-3)", async () => {
    const fx = makeInteraction({ inThread: false });
    await fx.run();

    expect(fx.compactCalls).toHaveLength(0);
    expect(fx.hasCalls).toHaveLength(0);
    const hint = fx.replies.find((r) => r.kind === "reply");
    expect(hint?.content).toContain("スレッド内で実行");
    expect(hint?.flags).toBe(64);
  });

  test("compactSession failure: reports error via editReply after defer, without leaking the raw cause (#360)", async () => {
    const fx = makeInteraction({
      compactImpl: () => {
        throw new Error("tmux session dead");
      },
    });
    await fx.run();

    const err = fx.replies.find(
      (r) => r.kind === "editReply" && r.content?.includes("失敗")
    );
    expect(err).toBeDefined();
    // Issue #360: the raw error message must never reach the Discord reply —
    // only console.error (diagnostics). The user still gets an actionable
    // notice with the command's recovery guidance.
    expect(err?.content).not.toContain("tmux session dead");
    expect(err?.content).toContain("/session status");
  });

  test("#366: a user outside allowFrom is refused, no send-keys, no has() lookup", async () => {
    const fx = makeInteraction({ userId: OUTSIDER });
    await fx.run();

    expect(fx.compactCalls).toHaveLength(0);
    expect(fx.hasCalls).toHaveLength(0);
    const deny = fx.replies.find((r) => r.kind === "reply");
    expect(deny?.content).toContain("権限がありません");
    expect(deny?.flags).toBe(64);
  });

  test("#366: fail-closed when access.json is missing", async () => {
    rmSync(join(dir, "access.json"));
    const fx = makeInteraction({});
    await fx.run();

    expect(fx.compactCalls).toHaveLength(0);
    const deny = fx.replies.find((r) => r.kind === "reply");
    expect(deny?.content).toContain("権限がありません");
  });
});

/**
 * #199 AC1: the claudeHubExit primary channel is a normal text channel (not a
 * thread) whose long-lived session runs on the DEFAULT tmux socket, outside
 * SessionManager. `/session compact` invoked there must route to
 * compactPrimarySession (NOT the thread-bound compactSession), gated on the
 * HIJOGUCHI_CHANNEL_ID env so it fail-safes to the usage hint when the
 * Supervisor isn't told the primary channel id.
 *
 * Issue #366: this branch gets the same access.json gate as the thread-bound
 * one, keyed on the primary channel id itself (it is not a thread).
 */
describe("/session compact in claudeHubExit primary channel (#199 AC1)", () => {
  const PRIMARY = PRIMARY_CHANNEL_ID;
  let dir: string;
  const prevAccess = process.env.SUPERVISOR_ACCESS_JSON_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-compact-primary-access-"));
    const path = join(dir, "access.json");
    writeFileSync(
      path,
      JSON.stringify({
        groups: {
          [PRIMARY]: { requireMention: false, allowFrom: [] },
          // Also present so the "non-primary channel id" test below (which
          // exercises the thread-bound branch) is unaffected by this describe's
          // access.json.
          [PARENT_CHANNEL_ID]: { requireMention: true, allowFrom: [OWNER] },
        },
      })
    );
    process.env.SUPERVISOR_ACCESS_JSON_PATH = path;
  });

  afterEach(() => {
    delete process.env.HIJOGUCHI_CHANNEL_ID;
    if (prevAccess === undefined)
      delete process.env.SUPERVISOR_ACCESS_JSON_PATH;
    else process.env.SUPERVISOR_ACCESS_JSON_PATH = prevAccess;
    rmSync(dir, { recursive: true, force: true });
  });

  test("primary channel + explicit intent: routes to compactPrimarySession, never compactSession, ephemeral ack", async () => {
    process.env.HIJOGUCHI_CHANNEL_ID = PRIMARY;
    const fx = makeInteraction({
      inThread: false,
      channelId: PRIMARY,
      intent: "残作業: Epic #182 dispatcher follow-up",
    });
    await fx.run();

    expect(fx.primaryCompactCalls).toEqual([
      { intent: "残作業: Epic #182 dispatcher follow-up" },
    ]);
    // Must not touch the thread-bound path.
    expect(fx.compactCalls).toHaveLength(0);
    expect(fx.hasCalls).toHaveLength(0);
    // Ephemeral ack confirming the relayed text.
    expect(fx.replies.some((r) => r.flags === 64)).toBe(true);
    const ack = fx.replies.find((r) => r.kind === "editReply");
    expect(ack?.content).toContain("/compact 残作業: Epic #182 dispatcher follow-up");
  });

  test("primary channel + omitted intent: substitutes default (RW-032)", async () => {
    process.env.HIJOGUCHI_CHANNEL_ID = PRIMARY;
    const fx = makeInteraction({ inThread: false, channelId: PRIMARY, intent: null });
    await fx.run();

    expect(fx.primaryCompactCalls).toHaveLength(1);
    expect(fx.primaryCompactCalls[0]?.intent).toBe(DEFAULT_COMPACT_INTENT);
  });

  test("primary channel + dead claudeHubExit: reports error via editReply, without leaking the raw cause (#360)", async () => {
    process.env.HIJOGUCHI_CHANNEL_ID = PRIMARY;
    const fx = makeInteraction({
      inThread: false,
      channelId: PRIMARY,
      primaryCompactImpl: () => {
        throw new Error("claudeHubExit session dead");
      },
    });
    await fx.run();

    const err = fx.replies.find(
      (r) => r.kind === "editReply" && r.content?.includes("失敗")
    );
    // Issue #360: same contract as the thread-bound compact catch above.
    expect(err?.content).not.toContain("claudeHubExit session dead");
    expect(err?.content).toContain("/session status");
  });

  test("HIJOGUCHI_CHANNEL_ID unset: primary channel falls through to usage hint, no primary compact", async () => {
    // env intentionally unset (afterEach cleared it)
    const fx = makeInteraction({ inThread: false, channelId: PRIMARY });
    await fx.run();

    expect(fx.primaryCompactCalls).toHaveLength(0);
    const hint = fx.replies.find((r) => r.kind === "reply");
    expect(hint?.content).toContain("スレッド内で実行");
    expect(hint?.flags).toBe(64);
  });

  test("non-primary channel id with env set: unaffected (still thread-bound path)", async () => {
    process.env.HIJOGUCHI_CHANNEL_ID = PRIMARY;
    const fx = makeInteraction({ intent: "通常スレッド" }); // default channelId = thread-compact-1, inThread true
    await fx.run();

    expect(fx.primaryCompactCalls).toHaveLength(0);
    expect(fx.compactCalls).toHaveLength(1);
  });

  test("#366: primary channel user outside allowFrom is refused, no primary compact", async () => {
    writeFileSync(
      join(dir, "access.json"),
      JSON.stringify({
        groups: {
          [PRIMARY]: { requireMention: false, allowFrom: [OWNER] },
        },
      })
    );
    process.env.HIJOGUCHI_CHANNEL_ID = PRIMARY;
    const fx = makeInteraction({
      inThread: false,
      channelId: PRIMARY,
      userId: OUTSIDER,
    });
    await fx.run();

    expect(fx.primaryCompactCalls).toHaveLength(0);
    const deny = fx.replies.find((r) => r.kind === "reply");
    expect(deny?.content).toContain("権限がありません");
    expect(deny?.flags).toBe(64);
  });
});
