import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Handler-level tests for `/session resume <session_id>` (Issue #161).
 *
 * Mirrors session-start-branch.test.ts: a minimal fake
 * ChatInputCommandInteraction exercises the real handler without a Discord
 * gateway. `findResumableSession` is stubbed on the fake SessionManager so the
 * handler's validation branches are covered without a real DB.
 *
 * "team-salary" is a real CHANNEL_MAP key, so the channel-registration gate
 * passes; "claude-hub-hijoguchi" is intentionally NOT in CHANNEL_MAP.
 *
 * Issue #451 (devils-advocate review on the hub-work resume fix): `handleResume`
 * now enforces access.json exactly like `handleStart` does (Issue #32 / S7
 * Critical) — resume spawns a `--dangerously-skip-permissions` Claude process
 * just like start does, and without this gate the hub-work special-case added
 * for #451 would let anyone in a registered channel relaunch a session in the
 * claude-hub repo itself. These validation tests assert behavior AFTER access
 * is granted (mirrors session-start-branch.test.ts); access-denial behavior is
 * covered in session-resume-access.test.ts.
 */
const FIXTURE_CHANNEL_ID = "fixture-parent-channel";
const FIXTURE_USER_ID = "fixture-user";
let accessDir: string;
const prevAccessPath = process.env.SUPERVISOR_ACCESS_JSON_PATH;

beforeEach(() => {
  accessDir = mkdtempSync(join(tmpdir(), "session-resume-access-"));
  const accessPath = join(accessDir, "access.json");
  writeFileSync(
    accessPath,
    JSON.stringify({
      groups: {
        [FIXTURE_CHANNEL_ID]: {
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

const VALID_ID = "3139aa23-fe2a-485a-831a-2209081f9935";

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

interface ResumableRow {
  channel_name: string;
  project_dir: string;
  status: string;
}

function makeInteraction(opts: {
  sessionId?: string | null;
  channelName?: string;
  resumableRow?: ResumableRow | undefined;
  resumeImpl?: (...args: unknown[]) => unknown;
  sendImpl?: () => unknown;
  /**
   * Issue #171: the handler now keys the "already running" guard on the
   * authoritative liveness verdict, not the DB `status` column. Defaults to
   * "dead" so legacy stopped-row tests keep passing.
   */
  liveness?: "alive" | "dead" | "unknown";
  /**
   * Issue #451 (devils-advocate review gap): simulate running `/session
   * resume` from INSIDE a thread (e.g. the dead hub-work thread itself) whose
   * parent is `channelName`, instead of from the top-level channel. Exercises
   * the `channel.isThread() && channel.parent` branch that resolves
   * `channelName` via the parent, which the non-thread mock never reaches.
   */
  asThread?: boolean;
}) {
  const replies: ReplyRecord[] = [];
  const resumeCalls: unknown[][] = [];
  const findCalls: string[] = [];
  const stopCalls: unknown[][] = [];
  let threadCreated = false;
  let threadDeleted = false;

  const thread = {
    id: "thread-resume-1",
    send: async () => {
      opts.sendImpl?.();
    },
    delete: async () => {
      threadDeleted = true;
    },
  };

  // Reused as both the top-level channel (non-thread case) and the parent
  // channel (thread case) — both need isTextBased/isDMBased/threads.create,
  // and reusing FIXTURE_CHANNEL_ID as its id keeps the access.json fixture
  // above valid for either shape.
  const parentChannelLike = {
    id: FIXTURE_CHANNEL_ID,
    name: opts.channelName ?? "team-salary",
    isTextBased: () => true,
    isDMBased: () => false,
    threads: {
      create: async () => {
        threadCreated = true;
        return thread;
      },
    },
  };

  const channel = opts.asThread
    ? {
        id: "dead-hub-work-thread-id",
        isThread: () => true,
        parent: parentChannelLike,
        parentId: parentChannelLike.id,
        isTextBased: () => true,
        isDMBased: () => false,
      }
    : { ...parentChannelLike, isThread: () => false };

  const interaction = {
    user: { id: FIXTURE_USER_ID },
    options: {
      getSubcommand: () => "resume",
      getString: (name: string) =>
        name === "session_id" ? opts.sessionId ?? null : null,
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
    livenessOfClaudeSession: () => opts.liveness ?? "dead",
    findResumableSession: (id: string) => {
      findCalls.push(id);
      return opts.resumableRow;
    },
    resumeSession: (...args: unknown[]) => {
      resumeCalls.push(args);
      return opts.resumeImpl?.(...args) ?? { id: "sess-1" };
    },
    stop: async (...args: unknown[]) => {
      stopCalls.push(args);
    },
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
    resumeCalls,
    findCalls,
    stopCalls,
    get threadCreated() {
      return threadCreated;
    },
    get threadDeleted() {
      return threadDeleted;
    },
  };
}

describe("/session resume validation (#161)", () => {
  test("no session_id → ephemeral usage error, no resume, no thread", async () => {
    const h = makeInteraction({ sessionId: null });
    await h.run();

    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.flags).toBe(64);
    expect(h.replies[0]!.content).toContain("session_id が必須");
  });

  test("whitespace-only session_id is also rejected", async () => {
    const h = makeInteraction({ sessionId: "   " });
    await h.run();
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
  });

  test("unregistered channel → 未登録 error, no DB lookup", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "claude-hub-hijoguchi",
    });
    await h.run();
    expect(h.findCalls).toHaveLength(0);
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.replies[0]!.content).toContain("未登録");
  });

  test("session_id not found → error, no thread", async () => {
    const h = makeInteraction({ sessionId: VALID_ID, resumableRow: undefined });
    await h.run();
    expect(h.findCalls).toEqual([VALID_ID]);
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies[0]!.content).toContain("見つかりません");
  });

  test("session from a different channel → error", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "agent-base",
        project_dir: "/Users/x/agent-base",
        status: "stopped",
      },
    });
    await h.run();
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.replies[0]!.content).toContain("別チャンネル");
    expect(h.replies[0]!.content).toContain("agent-base");
  });

  test("hub-work row (#451) resumed from #corp → resumeSession called with hub-work config", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "corp",
      resumableRow: {
        channel_name: "claude-hub-work",
        project_dir: "/Users/x/claude-hub",
        status: "stopped",
      },
    });
    await h.run();

    expect(h.threadCreated).toBe(true);
    expect(h.resumeCalls).toHaveLength(1);
    // resumeSession(config, threadId, sessionId, projectDir, branch) — the
    // config passed must be the ephemeral hub-work config (channelName
    // "claude-hub-work"), never CHANNEL_MAP's real "corp" entry, and CHANNEL_MAP
    // itself must stay untouched (absolute rule).
    const passedConfig = h.resumeCalls[0]![0] as { channelName: string };
    expect(passedConfig.channelName).toBe("claude-hub-work");
    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies[editReplies.length - 1]!.content).toContain("復帰しました");
  });

  test("hub-work row (#451) resumed from INSIDE the dead hub-work thread (parent=#corp)", async () => {
    // devils-advocate review gap: resume is most often invoked from inside the
    // archived hub-work thread itself, not from the top-level #corp channel.
    // channelName must resolve via channel.parent.name in that case.
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "corp",
      asThread: true,
      resumableRow: {
        channel_name: "claude-hub-work",
        project_dir: "/Users/x/claude-hub",
        status: "stopped",
      },
    });
    await h.run();

    expect(h.threadCreated).toBe(true);
    expect(h.resumeCalls).toHaveLength(1);
    const passedConfig = h.resumeCalls[0]![0] as { channelName: string };
    expect(passedConfig.channelName).toBe("claude-hub-work");
  });

  test("hub-work row (#451) resume attempted outside #corp → rejected, guided to #corp", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "claude-hub-work",
        project_dir: "/Users/x/claude-hub",
        status: "stopped",
      },
    });
    await h.run();

    expect(h.resumeCalls).toHaveLength(0);
    expect(h.threadCreated).toBe(false);
    expect(h.replies[0]!.content).toContain("corp");
  });

  test("session genuinely alive (liveness=alive) → warns, no resume (#171 穴 A)", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      liveness: "alive",
      resumableRow: {
        channel_name: "team-salary",
        project_dir: "/Users/x/team_salary",
        status: "running",
      },
    });
    await h.run();
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.replies[0]!.content).toContain("既に稼働中");
  });

  test("stale status='running' but liveness=dead → resume proceeds (#171 穴 A)", async () => {
    // The DB row still says running (process died without a clean stop), but the
    // authoritative liveness verdict is dead — the handler must NOT block resume.
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      liveness: "dead",
      resumableRow: {
        channel_name: "team-salary",
        project_dir: "/Users/x/team_salary",
        status: "running",
      },
    });
    await h.run();
    expect(h.threadCreated).toBe(true);
    expect(h.resumeCalls).toHaveLength(1);
  });

  test("valid stopped session → resumeSession called with project_dir, thread created", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "team-salary",
        project_dir: "/Users/x/team_salary",
        status: "stopped",
      },
    });
    await h.run();

    expect(h.threadCreated).toBe(true);
    expect(h.resumeCalls).toHaveLength(1);
    // resumeSession(config, threadId, sessionId, projectDir)
    expect(h.resumeCalls[0]![1]).toBe("thread-resume-1");
    expect(h.resumeCalls[0]![2]).toBe(VALID_ID);
    expect(h.resumeCalls[0]![3]).toBe("/Users/x/team_salary");

    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies[editReplies.length - 1]!.content).toContain("復帰しました");
  });

  test("resume failure → orphan thread deleted + error surfaced", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "team-salary",
        project_dir: "/Users/x/team_salary",
        status: "stopped",
      },
      resumeImpl: () => {
        throw new Error("プロジェクトディレクトリが見つかりません");
      },
    });
    await h.run();

    expect(h.threadCreated).toBe(true);
    expect(h.threadDeleted).toBe(true);
    // resumeSession never completed → no live session to stop.
    expect(h.stopCalls).toHaveLength(0);
    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies[editReplies.length - 1]!.content).toContain(
      "セッション復帰に失敗"
    );
  });

  test("notify failure after resume → session stopped, then thread deleted (PR #162: CodeRabbit Major)", async () => {
    const h = makeInteraction({
      sessionId: VALID_ID,
      channelName: "team-salary",
      resumableRow: {
        channel_name: "team-salary",
        project_dir: "/Users/x/team_salary",
        status: "stopped",
      },
      // resumeSession succeeds (default impl), but the welcome message fails.
      sendImpl: () => {
        throw new Error("Discord API 5xx");
      },
    });
    await h.run();

    expect(h.threadCreated).toBe(true);
    // The live session must be stopped so it is not orphaned (unreachable).
    expect(h.stopCalls).toHaveLength(1);
    expect(h.stopCalls[0]![0]).toBe("thread-resume-1");
    // The thread is then discarded and the error is surfaced.
    expect(h.threadDeleted).toBe(true);
    const editReplies = h.replies.filter((r) => r.kind === "editReply");
    expect(editReplies[editReplies.length - 1]!.content).toContain(
      "セッション復帰に失敗"
    );
  });
});
