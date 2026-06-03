import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

// Isolate DB writes from the real sessions.db (mirrors tests/infra/db.test.ts).
process.env.SUPERVISOR_DB_PATH = ":memory:";

const { SessionManager } = await import("../../src/session/manager");
const { createFakeEffects } = await import(
  "../../src/session/adapters-fake"
);
const { insertSession, getDb } = await import("../../src/infra/db");
import type { FakeSessionEffects } from "../../src/session/adapters-fake";
import type { ChannelConfig } from "../../src/config/channels";

/**
 * Manager-level tests for SessionManager.resumeSession (Issue #161). Fake
 * adapters keep tmux / iTerm2 / relay out of the test; assertions target the
 * built claude command and the "Resume from summary" prompt auto-confirm.
 */

const VALID_ID = "3139aa23-fe2a-485a-831a-2209081f9935";
const THREAD_ID = "thread-resume-abc";
const tmuxName = `claude-${THREAD_ID.slice(0, 12)}`;

function makeProjectDir(): string {
  const dir = resolve(tmpdir(), `supervisor-resume-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(dir: string): ChannelConfig {
  return { channelName: "team-salary", dir, displayName: "Team Salary" };
}

describe("SessionManager.resumeSession (#161)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;
  let projectDir: string;

  beforeEach(() => {
    effects = createFakeEffects();
    projectDir = makeProjectDir();
  });

  afterEach(async () => {
    await manager?.shutdownAll();
  });

  test("builds `claude --resume <id>` with cd into the recorded projectDir", async () => {
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0, resumePromptPollAttempts: 0 });
    const info = await manager.resumeSession(
      makeConfig(projectDir),
      THREAD_ID,
      VALID_ID,
      projectDir
    );

    const cmd = effects.tmux.getCommand(tmuxName) ?? "";
    expect(cmd).toContain(`--resume ${VALID_ID}`);
    expect(cmd).toContain(`cd "${projectDir}"`);
    expect(cmd).toContain("--dangerously-skip-permissions");
    // AC-4: relay wiring identical to start() — SUPERVISOR_RELAY_URL is exported
    // and the per-thread relay endpoint is set so inbound/outbound relay works.
    expect(cmd).toContain("SUPERVISOR_RELAY_URL=");
    expect(cmd).toContain("/relay/");

    expect(info.claudeSessionId).toBe(VALID_ID);
    expect(info.projectDir).toBe(projectDir);
    expect(info.status).toBe("running");
    // No worktree for resume (resumes the recorded cwd, Q2).
    expect(info.worktree).toBeUndefined();
  });

  test("selects option 2 'Resume full session as-is' (Down + Enter) when the marker is present (#163)", async () => {
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      resumePromptPollAttempts: 3,
    });
    // The pane shows Claude's interactive resume prompt on first capture.
    effects.tmux.setPaneContent(
      tmuxName,
      "Resume from summary (recommended)\n❯ 1. ...\n  2. Resume full session as-is"
    );

    await manager.resumeSession(makeConfig(projectDir), THREAD_ID, VALID_ID, projectDir);

    const confirm = effects.tmux.sendKeysCalls.find(
      (c) => c.name === tmuxName
    );
    expect(confirm).toBeDefined();
    // Down moves from the highlighted option 1 (summary) to option 2 (full),
    // then Enter confirms — we always want the full session (Issue #163).
    expect(confirm!.keys).toEqual(["Down", "C-m"]);
  });

  test("does not send keys when no resume prompt appears", async () => {
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      resumePromptPollAttempts: 2,
      resumePromptPollIntervalMs: 5,
    });
    // capturePane returns "" (no marker) for the whole poll window.
    await manager.resumeSession(makeConfig(projectDir), THREAD_ID, VALID_ID, projectDir);

    expect(effects.tmux.sendKeysCalls).toHaveLength(0);
  });

  test("exits early without keys when the ready marker appears (no picker, #163)", async () => {
    // A large poll budget would hang the test if the loop ignored the ready
    // marker; the early-exit must return on the first capture.
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      resumePromptPollAttempts: 1000,
      resumePromptPollIntervalMs: 5,
    });
    // Non-compacted session: resumes straight to the input prompt (no picker).
    effects.tmux.setPaneContent(
      tmuxName,
      "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)"
    );

    await manager.resumeSession(makeConfig(projectDir), THREAD_ID, VALID_ID, projectDir);

    // No picker → no keystrokes, and the resume completed (did not exhaust the
    // 1000-attempt window).
    expect(effects.tmux.sendKeysCalls).toHaveLength(0);
    expect(manager.has(THREAD_ID)).toBe(true);
  });

  test("rejects a malformed (non-UUID) session id before launching", async () => {
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0, resumePromptPollAttempts: 0 });
    await expect(
      manager.resumeSession(
        makeConfig(projectDir),
        THREAD_ID,
        "not-a-uuid; rm -rf /",
        projectDir
      )
    ).rejects.toThrow(/形式が不正/);
    expect(effects.tmux.list()).toHaveLength(0);
  });

  test("rejects when the recorded projectDir no longer exists", async () => {
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0, resumePromptPollAttempts: 0 });
    const gone = resolve(tmpdir(), `supervisor-resume-gone-${process.pid}`);
    rmSync(gone, { recursive: true, force: true });
    await expect(
      manager.resumeSession(makeConfig(gone), THREAD_ID, VALID_ID, gone)
    ).rejects.toThrow(/見つかりません/);
  });

  test("rolls back the tmux session if post-launch init throws (PR #162: CodeRabbit Major)", async () => {
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      resumePromptPollAttempts: 3,
    });
    // Prompt marker present → confirmResumePromptIfPresent calls sendKeys, which
    // we force to throw, simulating a failure after tmux has already started.
    effects.tmux.setPaneContent(
      tmuxName,
      "Resume from summary (recommended)\n❯ 1. ..."
    );
    effects.tmux.failOnSendKeys = true;

    await expect(
      manager.resumeSession(makeConfig(projectDir), THREAD_ID, VALID_ID, projectDir)
    ).rejects.toThrow(/sendKeys failed/);

    // No orphaned tmux session, and no half-registered session state.
    expect(effects.tmux.list()).toHaveLength(0);
    expect(manager.has(THREAD_ID)).toBe(false);
    expect(manager.count()).toBe(0);
  });
});

/**
 * Single-flight + liveness guard for resume (Issue #171). Covers 穴 A (DB
 * `status` column must not be trusted over real liveness) and 穴 C (two near-
 * simultaneous resumes of the same claude session id must not both launch —
 * RW-046-type transcript double-write). Clears the shared in-memory DB in
 * beforeEach so inserted rows are the only ones livenessOfClaudeSession sees.
 */
function tmuxNameForThread(threadId: string): string {
  return `claude-${threadId.slice(0, 12)}`;
}

describe("SessionManager resume single-flight & liveness (#171)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;
  let projectDir: string;

  beforeEach(() => {
    getDb().exec("DELETE FROM sessions");
    effects = createFakeEffects();
    projectDir = makeProjectDir();
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      resumePromptPollAttempts: 0,
    });
  });

  afterEach(async () => {
    await manager?.shutdownAll();
  });

  test("穴 C: two concurrent resumes of the same claude session id — only one launches, the other is rejected", async () => {
    const cfg = makeConfig(projectDir);
    // Both invoked synchronously up to their first await: the first acquires the
    // in-flight lock and suspends inside launchResume; the second sees the held
    // lock and throws before touching tmux.
    const results = await Promise.allSettled([
      manager.resumeSession(cfg, "thread-A", VALID_ID, projectDir),
      manager.resumeSession(cfg, "thread-B", VALID_ID, projectDir),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason.message
    ).toMatch(/多重 resume 防止|稼働中/);
    // Exactly one tmux session was launched (no duplicate `claude --resume`).
    expect(effects.tmux.list()).toHaveLength(1);
  });

  test("穴 A: a stale status='running' row whose process is dead does NOT block resume", async () => {
    // Prior run recorded as running, but its pid is dead and no tmux session
    // exists → authoritative liveness is `dead`, so resume must proceed.
    insertSession({
      id: "stale-run",
      channel_name: "team-salary",
      thread_id: "old-dead-thread",
      project_dir: projectDir,
      pid: 9999, // not in alivePids → dead
      claude_session_id: VALID_ID,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
      branch: null,
    });

    const info = await manager.resumeSession(
      makeConfig(projectDir),
      "fresh-thread",
      VALID_ID,
      projectDir
    );
    expect(info.status).toBe("running");
    expect(manager.has("fresh-thread")).toBe(true);
  });

  test("穴 A: a genuinely-live session (pid alive + tmux present) rejects resume", async () => {
    const oldThread = "alive-old-thread";
    effects.tmux.newSession(tmuxNameForThread(oldThread), "exec claude");
    const oldPid = effects.tmux.getPid(tmuxNameForThread(oldThread))!;
    effects.process.alivePids.add(oldPid);
    insertSession({
      id: "live-run",
      channel_name: "team-salary",
      thread_id: oldThread,
      project_dir: projectDir,
      pid: oldPid,
      claude_session_id: VALID_ID,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
      branch: null,
    });

    await expect(
      manager.resumeSession(
        makeConfig(projectDir),
        "alive-new-thread",
        VALID_ID,
        projectDir
      )
    ).rejects.toThrow(/稼働中/);
    expect(manager.has("alive-new-thread")).toBe(false);
    // No new tmux session for the rejected resume (only the pre-existing one).
    expect(effects.tmux.hasSession(tmuxNameForThread("alive-new-thread"))).toBe(
      false
    );
  });

  test("the in-flight lock is released after a successful resume (a later resume of the same id is not falsely blocked)", async () => {
    const cfg = makeConfig(projectDir);
    await manager.resumeSession(cfg, "first-thread", VALID_ID, projectDir);
    // Stop the first so liveness is no longer alive, then resume again: must not
    // be rejected by a leaked lock.
    await manager.stop("first-thread");
    const info = await manager.resumeSession(
      cfg,
      "second-thread",
      VALID_ID,
      projectDir
    );
    expect(info.status).toBe("running");
  });
});
