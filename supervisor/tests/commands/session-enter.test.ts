import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createSessionCommand,
  createSessionHandler,
} from "../../src/commands/session";

/**
 * Issue #357 AC-2 (journey): "万一 stall した場合に、Discord 上の復旧コマンドのみを
 * 実行 → ターミナルに触れず未送信バッファが確定する".
 *
 * `/session enter` sends one bare Enter to the session bound to THIS thread.
 * Like `/session start` it sends keys into a `--dangerously-skip-permissions`
 * session, so it is gated on access.json `allowFrom` (fail-closed).
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
  userId?: string;
  inThread?: boolean;
  hasSession?: boolean;
  enterImpl?: (threadId: string) => unknown;
}) {
  const replies: ReplyRecord[] = [];
  const enterCalls: string[] = [];
  const inThread = opts.inThread ?? true;
  const channel = {
    id: "thread-enter-1",
    parentId: PARENT_CHANNEL_ID,
    isThread: () => inThread,
  };
  const interaction = {
    user: { id: opts.userId ?? OWNER },
    options: {
      getSubcommand: () => "enter",
      getString: () => null,
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
      replies.push({ kind: "reply", flags: msg?.flags });
    },
    async editReply(msg: { content?: string }) {
      replies.push({ kind: "editReply", content: msg.content });
    },
  };
  const sessionManager = {
    has: () => opts.hasSession ?? true,
    sendEnter: async (threadId: string) => {
      enterCalls.push(threadId);
      return opts.enterImpl?.(threadId);
    },
  };
  return {
    run: () => createSessionHandler(sessionManager as never)(interaction as never),
    replies,
    enterCalls,
  };
}

describe("/session enter (#357)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-enter-"));
    const path = join(dir, "access.json");
    writeFileSync(
      path,
      JSON.stringify({
        dmPolicy: "allowlist",
        allowFrom: [OWNER],
        groups: {
          [PARENT_CHANNEL_ID]: { requireMention: false, allowFrom: [OWNER] },
        },
      })
    );
    process.env.SUPERVISOR_ACCESS_JSON_PATH = path;
  });

  afterEach(() => {
    delete process.env.SUPERVISOR_ACCESS_JSON_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  test("is registered as a /session subcommand", () => {
    const json = createSessionCommand().toJSON() as {
      options?: { name: string }[];
    };
    expect(json.options?.map((o) => o.name)).toContain("enter");
  });

  test("owner in a session thread: sends Enter to this thread's session, ephemeral ack", async () => {
    const fx = makeInteraction({});
    await fx.run();
    expect(fx.enterCalls).toEqual(["thread-enter-1"]);
    expect(fx.replies.some((r) => r.flags === 64)).toBe(true);
    const ack = fx.replies.find((r) => r.kind === "editReply");
    expect(ack?.content).toContain("Enter");
  });

  test("a user outside allowFrom is refused and no key is sent", async () => {
    const fx = makeInteraction({ userId: OUTSIDER });
    await fx.run();
    expect(fx.enterCalls).toHaveLength(0);
    const deny = fx.replies.find((r) => r.kind === "reply");
    expect(deny?.content).toContain("権限");
    expect(deny?.flags).toBe(64);
  });

  test("outside a thread: usage hint, no key sent", async () => {
    const fx = makeInteraction({ inThread: false });
    await fx.run();
    expect(fx.enterCalls).toHaveLength(0);
    expect(fx.replies.find((r) => r.kind === "reply")?.content).toContain("スレッド内で実行");
  });

  test("no session in this thread: hint, no key sent", async () => {
    const fx = makeInteraction({ hasSession: false });
    await fx.run();
    expect(fx.enterCalls).toHaveLength(0);
    expect(fx.replies.find((r) => r.kind === "reply")?.content).toContain(
      "稼働中のセッションはありません"
    );
  });

  test("a send failure is reported, never acked as sent, without leaking the raw cause (#360)", async () => {
    const fx = makeInteraction({
      enterImpl: () => {
        throw new Error("tmux session dead");
      },
    });
    await fx.run();
    const err = fx.replies.find((r) => r.kind === "editReply");
    expect(err?.content).toContain("失敗");
    // Issue #360: the raw error message must never reach the Discord reply —
    // only console.error (diagnostics).
    expect(err?.content).not.toContain("tmux session dead");
    expect(err?.content).toContain("/session status");
  });
});
