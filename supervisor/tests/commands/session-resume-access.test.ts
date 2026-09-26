import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Issue #451 (devils-advocate review): `/session resume` must enforce
 * access.json `allowFrom` BEFORE resuming a session, exactly like `/session
 * start` already does (Issue #32 / S7 Critical). Resume spawns a Claude
 * process with `--dangerously-skip-permissions` just as start does — before
 * this check, anyone able to run a slash command in a registered channel
 * could relaunch ANY resumable session, including — once the hub-work
 * special-case (#451) makes it reachable at all — a hub-work session running
 * in the claude-hub repo itself (the most sensitive repo in the system).
 * Fail-closed: missing/broken policy or an undefined channel denies.
 *
 * Mirrors session-start-access.test.ts exactly, pointed at the "resume"
 * subcommand instead of "start".
 */

const PARENT_CHANNEL_ID = "846209781206941736";
const OWNER = "184695080709324800";
const OUTSIDER = "999999999999999999";
const VALID_ID = "3139aa23-fe2a-485a-831a-2209081f9935";

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

function makeInteraction(opts: { userId: string; channelId?: string }) {
  const replies: ReplyRecord[] = [];
  const resumeCalls: unknown[][] = [];
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
    name: "agent-base",
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
      getSubcommand: () => "resume",
      getString: (name: string) => (name === "session_id" ? VALID_ID : null),
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
    livenessOfClaudeSession: () => "dead" as const,
    findResumableSession: () => ({
      channel_name: "agent-base",
      project_dir: "/Users/x/agent-base",
      status: "stopped",
    }),
    resumeSession: (...args: unknown[]) => {
      resumeCalls.push(args);
      return { id: "sess-1" };
    },
    stop: async () => {},
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
    resumeCalls,
    get threadCreated() {
      return threadCreated;
    },
  };
}

describe("/session resume access enforcement (#451)", () => {
  let dir: string;
  let accessPath: string;
  const prev = process.env.SUPERVISOR_ACCESS_JSON_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-resume-access-"));
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

  test("allowlisted user can resume: resumeSession called, thread created", async () => {
    writePolicy([OWNER]);
    const h = makeInteraction({ userId: OWNER });
    await h.run();
    expect(h.resumeCalls).toHaveLength(1);
    expect(h.threadCreated).toBe(true);
  });

  test("non-allowlisted user is rejected: no resume, no thread", async () => {
    writePolicy([OWNER]);
    const h = makeInteraction({ userId: OUTSIDER });
    await h.run();
    expect(h.resumeCalls).toHaveLength(0);
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
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies[0]!.content).toContain("権限がありません");
  });

  test("fail-closed: channel not present in groups denies", async () => {
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
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
  });

  test("fail-closed: corrupt access.json denies", async () => {
    writeFileSync(accessPath, "{ not json ");
    const h = makeInteraction({ userId: OWNER });
    await h.run();
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
  });

  test("empty allowFrom permits any member (slash invocation satisfies mention)", async () => {
    writePolicy([]); // empty = any member
    const h = makeInteraction({ userId: OUTSIDER });
    await h.run();
    expect(h.resumeCalls).toHaveLength(1);
    expect(h.threadCreated).toBe(true);
  });
});
