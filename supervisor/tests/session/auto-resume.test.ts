import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate DB writes from the real sessions.db (mirrors salvage-reply.test.ts).
// Must precede any module that transitively loads infra/db, hence the dynamic
// imports below.
process.env.SUPERVISOR_DB_PATH = ":memory:";

const { insertSession, updateSessionStatus, getDb, getSessionByThreadId } =
  await import("../../src/infra/db");
const { autoResumeThread } = await import("../../src/session/auto-resume");
const { SessionManager } = await import("../../src/session/manager");
const { createFakeEffects } = await import("../../src/session/adapters-fake");
const { MAX_SESSIONS } = await import("../../src/config/channels");

import type { ChannelConfig } from "../../src/config/channels";
import type { FakeSessionEffects } from "../../src/session/adapters-fake";

/**
 * Message-triggered wake (Issue #456): an inbound message on a thread that has
 * session history resumes that session INTO THAT THREAD instead of answering
 * with manual `/session resume` guidance.
 *
 * The AC numbering below is the Issue's 統合ジャーニーAC list. Fake adapters
 * stand in for tmux / iTerm2 / relay, so these run hermetically; AC-1's
 * Discord-side half (the reply the user sees) is asserted through the returned
 * notice, which bot.ts posts verbatim.
 */

const CHANNEL = "agent-base";

/** Distinct ids per row — resume's single-flight guard is keyed by claude id. */
function uuid(n: number): string {
  const tail = String(n).padStart(12, "0");
  return `11111111-1111-4111-8111-${tail}`;
}

describe("autoResumeThread (#456)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;
  let projectDir: string;
  let channelMap: Map<string, ChannelConfig>;
  let tmpRoot: string;

  beforeEach(() => {
    getDb().run("DELETE FROM sessions");
    effects = createFakeEffects();
    // resumePromptPollAttempts: 0 keeps the "Resume from summary" poll out of
    // these tests (manager-resume.test.ts covers it).
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      resumePromptPollAttempts: 0,
    });
    tmpRoot = mkdtempSync(join(tmpdir(), "auto-resume-"));
    projectDir = join(tmpRoot, "project");
    mkdirSync(projectDir, { recursive: true });
    channelMap = new Map<string, ChannelConfig>([
      [CHANNEL, { channelName: CHANNEL, dir: projectDir, displayName: "Agent Base" }],
    ]);
  });

  afterEach(async () => {
    await manager?.shutdownAll();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Insert a row for `threadId` and mark it stopped, as a real stop would. */
  function seedStoppedSession(
    threadId: string,
    opts: { id?: string; claudeSessionId?: string | null; branch?: string | null } = {},
  ): string | null {
    const id = opts.id ?? `row-${threadId}`;
    const claudeSessionId =
      opts.claudeSessionId === undefined ? uuid(1) : opts.claudeSessionId;
    const now = new Date().toISOString();
    insertSession({
      id,
      channel_name: CHANNEL,
      thread_id: threadId,
      project_dir: projectDir,
      pid: 4242,
      claude_session_id: claudeSessionId,
      started_at: now,
      last_activity_at: now,
      status: "running",
      branch: opts.branch ?? null,
    });
    updateSessionStatus(id, "stopped", "supervisor_restart");
    return claudeSessionId;
  }

  test("AC-1: a stopped thread is resumed into that same thread", async () => {
    const threadId = "thread-ac1";
    const claudeSessionId = seedStoppedSession(threadId)!;

    const outcome = await autoResumeThread(manager, threadId, { channelMap });

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.claudeSessionId).toBe(claudeSessionId);
    // The reply the user sees is an actual answer path, not resume guidance.
    expect(outcome.notice).toContain("自動で復帰");
    expect(outcome.notice).not.toContain("セッション履歴がありません");

    // Resumed in-place: the session is tracked under the SAME thread id, so the
    // caller's relay finds it and the triggering message reaches Claude.
    expect(manager.has(threadId)).toBe(true);
    const cmd = effects.tmux.getCommand(`claude-${threadId.slice(0, 12)}`) ?? "";
    expect(cmd).toContain(`--resume ${claudeSessionId}`);
    expect(cmd).toContain(`cd "${projectDir}"`);
  });

  test("AC-2: a thread with no history never starts a session", async () => {
    const outcome = await autoResumeThread(manager, "thread-never-seen", {
      channelMap,
    });

    expect(outcome.kind).toBe("no-history");
    expect(manager.count()).toBe(0);
    expect(manager.has("thread-never-seen")).toBe(false);
    expect(effects.tmux.list()).toEqual([]);
  });

  test("AC-3: a full session table fails loudly instead of silently", async () => {
    // Saturate the manager with live sessions so resume hits the guard.
    for (let i = 0; i < MAX_SESSIONS; i++) {
      await manager.resumeSession(
        channelMap.get(CHANNEL)!,
        `filler-thread-${i}`,
        uuid(100 + i),
        projectDir,
      );
    }
    expect(manager.count()).toBe(MAX_SESSIONS);

    const threadId = "thread-ac3";
    const claudeSessionId = seedStoppedSession(threadId, { id: "row-ac3" })!;

    const outcome = await autoResumeThread(manager, threadId, { channelMap });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("最大セッション数");
    expect(outcome.notice).toContain("最大セッション数");
    // Still actionable: the user can free a slot and resume by hand.
    expect(outcome.notice).toContain(`/session resume ${claudeSessionId}`);
    expect(manager.has(threadId)).toBe(false);
  });

  test("AC-4: wake is repeatable, not once-per-thread", async () => {
    const threadId = "thread-ac4";
    const claudeSessionId = seedStoppedSession(threadId)!;

    const first = await autoResumeThread(manager, threadId, { channelMap });
    expect(first.kind).toBe("resumed");

    // The resumed session dies again (supervisor restart / reaper).
    await manager.stop(threadId, "supervisor_restart");
    expect(manager.has(threadId)).toBe(false);
    // Resume wrote a fresh row for the same thread; that row is what the second
    // wake reads, so the history the thread carries survives the round trip.
    expect(getSessionByThreadId(threadId)?.claude_session_id).toBe(claudeSessionId);

    const second = await autoResumeThread(manager, threadId, { channelMap });
    expect(second.kind).toBe("resumed");
    if (second.kind !== "resumed") throw new Error("unreachable");
    expect(second.claudeSessionId).toBe(claudeSessionId);
    expect(manager.has(threadId)).toBe(true);
  });

  test("a session the Supervisor merely lost track of is not resumed", async () => {
    const threadId = "thread-alive";
    insertSession({
      id: "row-alive",
      channel_name: CHANNEL,
      thread_id: threadId,
      project_dir: projectDir,
      pid: 4242,
      claude_session_id: uuid(2),
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    // Reality agrees the process is up: the recorded pid answers, and a tmux
    // session exists under the deterministic `claude-<threadId12>` name.
    effects.process.alivePids.add(4242);
    await effects.tmux.newSession(`claude-${threadId.slice(0, 12)}`, "claude");

    const outcome = await autoResumeThread(manager, threadId, { channelMap });

    // Resuming a live claude session in the same cwd corrupts its transcript
    // (RW-046), so the caller falls back to the salvage wording instead.
    expect(outcome).toEqual({
      kind: "not-resumable",
      reason: "alive",
      // Handed to the caller so buildSalvageReply reuses it (#364 pattern).
      verdict: "alive",
    });
    expect(manager.has(threadId)).toBe(false);
  });

  test("a pre-#167 row with no claude_session_id is not resumable", async () => {
    const threadId = "thread-legacy";
    seedStoppedSession(threadId, { claudeSessionId: null });

    const outcome = await autoResumeThread(manager, threadId, { channelMap });

    expect(outcome).toEqual({
      kind: "not-resumable",
      reason: "no-claude-session-id",
      verdict: "dead",
    });
    expect(manager.has(threadId)).toBe(false);
  });

  test("an unregistered channel fails loudly rather than silently skipping", async () => {
    const threadId = "thread-unknown-channel";
    const claudeSessionId = seedStoppedSession(threadId)!;

    const outcome = await autoResumeThread(manager, threadId, {
      channelMap: new Map(),
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain(CHANNEL);
    expect(outcome.notice).toContain(`/session resume ${claudeSessionId}`);
  });

  test("concurrent messages on one thread share a single resume attempt", async () => {
    const threadId = "thread-concurrent";
    seedStoppedSession(threadId);

    // Two messages arriving back-to-back must not race into a second
    // `claude --resume` (which resumeSession would reject, turning a normal
    // double-post into a spurious failure notice).
    const [a, b] = await Promise.all([
      autoResumeThread(manager, threadId, { channelMap }),
      autoResumeThread(manager, threadId, { channelMap }),
    ]);

    expect(a.kind).toBe("resumed");
    expect(b.kind).toBe("resumed");
    // Exactly one resume ran...
    expect(manager.count()).toBe(1);
    expect(effects.tmux.list()).toEqual([`claude-${threadId.slice(0, 12)}`]);
    // ...and only the message that started it announces the wake, so a user
    // typing two lines does not get the banner twice.
    if (a.kind !== "resumed" || b.kind !== "resumed") {
      throw new Error("unreachable");
    }
    expect(a.notice).toContain("自動で復帰");
    expect(b.notice).toBeNull();
  });

  test("a DB read failure is reported, never mistaken for 'no history'", async () => {
    const outcome = await autoResumeThread(manager, "thread-db-broken", {
      channelMap,
      lookupSession: () => {
        throw new Error("database is locked");
      },
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("database is locked");
    expect(outcome.notice).not.toContain("セッション履歴がありません");
  });

  test("a liveness probe that throws is reported, not left as a rejection", async () => {
    // bot.ts awaits this straight from the messageCreate handler, so a
    // rejection would be an unhandled rejection AND leave the user with no
    // reply at all (PR #457 review, CodeRabbit major).
    const threadId = "thread-liveness-broken";
    seedStoppedSession(threadId);
    const exploding = {
      livenessOf: async () => {
        throw new Error("tmux control channel exploded");
      },
      resumeSession: async () => {
        throw new Error("must not be reached");
      },
    };

    const outcome = await autoResumeThread(exploding, threadId, { channelMap });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("tmux control channel exploded");
    expect(outcome.notice).toContain("自動復帰できませんでした");
  });
});
