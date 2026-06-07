import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Issue #32 / S7 (Critical): `/session start` must enforce access.json
 * `allowFrom` BEFORE creating a thread or spawning a Claude session (which
 * runs with `--dangerously-skip-permissions`). Fail-closed: missing/broken
 * policy or an undefined channel denies.
 *
 * These build a minimal fake ChatInputCommandInteraction (mirroring
 * session-start-branch.test.ts) and drive the real handler, pointing the
 * runtime access loader at a temp access.json via SUPERVISOR_ACCESS_JSON_PATH.
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
  userId: string;
  branch?: string | null;
  channelId?: string;
  channelName?: string;
}) {
  const replies: ReplyRecord[] = [];
  const startCalls: unknown[][] = [];
  let threadCreated = false;

  const thread = {
    id: "thread-xyz",
    send: async () => {},
    delete: async () => {},
  };

  const channel = {
    id: opts.channelId ?? PARENT_CHANNEL_ID,
    isThread: () => false,
    isTextBased: () => true,
    isDMBased: () => false,
    name: opts.channelName ?? "agent-base",
    threads: {
      create: async () => {
        threadCreated = true;
        return thread;
      },
    },
  };

  const interaction = {
    user: { id: opts.userId },
    options: {
      getSubcommand: () => "start",
      getString: (name: string) =>
        name === "branch" ? opts.branch ?? "feature-foo" : null,
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
    get threadCreated() {
      return threadCreated;
    },
  };
}

describe("/session start access enforcement (#32 / S7)", () => {
  let dir: string;
  let accessPath: string;
  const prev = process.env.SUPERVISOR_ACCESS_JSON_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-start-access-"));
    accessPath = join(dir, "access.json");
    process.env.SUPERVISOR_ACCESS_JSON_PATH = accessPath;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.SUPERVISOR_ACCESS_JSON_PATH;
    else process.env.SUPERVISOR_ACCESS_JSON_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  function writePolicy(allowFrom: string[]): void {
    writeFileSync(
      accessPath,
      JSON.stringify({
        groups: {
          [PARENT_CHANNEL_ID]: { requireMention: true, allowFrom },
        },
      }),
    );
  }

  test("allowlisted user can start: thread created, session started", async () => {
    writePolicy([OWNER]);
    const h = makeInteraction({ userId: OWNER });
    await h.run();
    expect(h.startCalls).toHaveLength(1);
    expect(h.threadCreated).toBe(true);
  });

  test("non-allowlisted user is rejected: no thread, no session", async () => {
    writePolicy([OWNER]);
    const h = makeInteraction({ userId: OUTSIDER });
    await h.run();
    expect(h.startCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.kind).toBe("reply");
    expect(h.replies[0]!.flags).toBe(64); // ephemeral
    expect(h.replies[0]!.content).toContain("権限がありません");
  });

  test("fail-closed: missing access.json denies even the would-be owner", async () => {
    // No writePolicy() — the file does not exist.
    const h = makeInteraction({ userId: OWNER });
    await h.run();
    expect(h.startCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies[0]!.content).toContain("権限がありません");
  });

  test("fail-closed: channel not present in groups denies", async () => {
    // Policy defines a DIFFERENT channel id, leaving this one undefined.
    writeFileSync(
      accessPath,
      JSON.stringify({
        groups: {
          "111111111111111111": { requireMention: true, allowFrom: [OWNER] },
        },
      }),
    );
    const h = makeInteraction({ userId: OWNER });
    await h.run();
    expect(h.startCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
  });

  test("fail-closed: corrupt access.json denies", async () => {
    writeFileSync(accessPath, "{ not json ");
    const h = makeInteraction({ userId: OWNER });
    await h.run();
    expect(h.startCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
  });

  test("empty allowFrom permits any member (slash invocation satisfies mention)", async () => {
    writePolicy([]); // empty = any member
    const h = makeInteraction({ userId: OUTSIDER });
    await h.run();
    expect(h.startCalls).toHaveLength(1);
    expect(h.threadCreated).toBe(true);
  });
});
