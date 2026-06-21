// Isolate DB writes from the real sessions.db (mirrors tests/infra/db.test.ts).
// Must be set before any module that transitively loads infra/db is imported,
// so everything below uses dynamic import after the env is in place.
process.env.SUPERVISOR_DB_PATH = ":memory:";

import { test, expect, describe, beforeEach } from "bun:test";

const { insertSession, updateSessionStatus, getDb } = await import(
  "../../src/infra/db"
);
const { buildSalvageReply, buildStatusReply } = await import(
  "../../src/session/status-reply"
);
const { SessionManager } = await import("../../src/session/manager");
const { createFakeEffects } = await import("../../src/session/adapters-fake");

/**
 * buildSalvageReply (Issue #169) turns a dead thread's silence into an
 * actionable reply: liveness verdict (Issue #168) + claude_session_id +
 * resume command. These tests cover the AC-critical "dead" paths.
 */
describe("buildSalvageReply (#169)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: ReturnType<typeof createFakeEffects>;

  beforeEach(() => {
    getDb().run("DELETE FROM sessions");
    effects = createFakeEffects();
    manager = new SessionManager({ effects });
  });

  // tmux name is deterministic: "claude-" + first 12 chars of threadId.
  const tmuxNameFor = (threadId: string) => `claude-${threadId.slice(0, 12)}`;

  test("no DB row → reports no history and suggests /session start", async () => {
    const reply = await buildSalvageReply(manager, "thread-never-seen");
    expect(reply).toContain("セッション履歴がありません");
    expect(reply).toContain("/session start");
  });

  test("dead session with claude_session_id → offers a resume command", async () => {
    const claudeId = "11111111-1111-1111-1111-111111111111";
    insertSession({
      id: "s-dead",
      channel_name: "agent-base",
      thread_id: "thread-dead",
      project_dir: "/tmp/x",
      pid: 4242,
      claude_session_id: claudeId,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    updateSessionStatus("s-dead", "stopped", "process_dead");

    const reply = await buildSalvageReply(manager, "thread-dead");
    expect(reply).toContain("停止しています");
    expect(reply).toContain("process_dead");
    expect(reply).toContain(claudeId);
    expect(reply).toContain(`/session resume ${claudeId}`);
  });

  test("dead session without claude_session_id → degrades to /session start (pre-#167)", async () => {
    insertSession({
      id: "s-noid",
      channel_name: "agent-base",
      thread_id: "thread-noid",
      project_dir: "/tmp/x",
      pid: null,
      claude_session_id: null,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    updateSessionStatus("s-noid", "stopped", "tmux_exited");

    const reply = await buildSalvageReply(manager, "thread-noid");
    expect(reply).toContain("停止しています");
    expect(reply).toContain("未記録");
    expect(reply).toContain("/session start");
    expect(reply).not.toContain("/session resume");
  });

  // verdict === "alive": running row + pid alive + tmux session present, but
  // Supervisor lost in-memory tracking (e.g. restart). gemini review on #178.
  test("alive (process up, Supervisor lost tracking) with id → suggests resume with the id", async () => {
    const claudeId = "22222222-2222-2222-2222-222222222222";
    const threadId = "thread-alive";
    insertSession({
      id: "s-alive",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 5151,
      claude_session_id: claudeId,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    effects.process.alivePids.add(5151);
    await effects.tmux.newSession(tmuxNameFor(threadId), "x");
    expect(await manager.livenessOf(threadId)).toBe("alive");

    const reply = await buildSalvageReply(manager, threadId);
    expect(reply).toContain("管理を見失っています");
    expect(reply).toContain(`/session resume ${claudeId}`);
  });

  test("alive without id → suggests start (resume is not actionable without an id)", async () => {
    const threadId = "thread-alivnoid";
    insertSession({
      id: "s-alive-noid",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 5252,
      claude_session_id: null,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    effects.process.alivePids.add(5252);
    await effects.tmux.newSession(tmuxNameFor(threadId), "x");
    expect(await manager.livenessOf(threadId)).toBe("alive");

    const reply = await buildSalvageReply(manager, threadId);
    expect(reply).toContain("管理を見失っています");
    expect(reply).toContain("/session start");
    expect(reply).not.toContain("/session resume");
  });
});

/**
 * buildStatusReply (Issue #170) is the explicit-query formatter. Unlike
 * salvage, `alive` means "running" (the session is live and tracked), while
 * dead/unknown reuse the salvage wording.
 */
describe("buildStatusReply (#170)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: ReturnType<typeof createFakeEffects>;

  beforeEach(() => {
    getDb().run("DELETE FROM sessions");
    effects = createFakeEffects();
    manager = new SessionManager({ effects });
  });

  const tmuxNameFor = (threadId: string) => `claude-${threadId.slice(0, 12)}`;

  test("alive (running + tracked) → reports 稼働中 with the id (not lost-tracking wording)", async () => {
    const claudeId = "33333333-3333-3333-3333-333333333333";
    const threadId = "thread-st-live";
    insertSession({
      id: "st-live",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 6161,
      claude_session_id: claudeId,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    effects.process.alivePids.add(6161);
    await effects.tmux.newSession(tmuxNameFor(threadId), "x");
    // "稼働中" requires the session to also be tracked in memory (has() true),
    // not just live by pid/tmux (gemini HIGH review, PR #179). Register a
    // minimal in-memory entry — has() only checks key presence.
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      threadId,
      { threadId }
    );

    const reply = await buildStatusReply(manager, threadId);
    expect(reply).toContain("稼働中");
    expect(reply).toContain(claudeId);
    expect(reply).not.toContain("見失って");
  });

  test("alive by pid/tmux but NOT tracked in memory → lost-tracking wording, not 稼働中", async () => {
    const threadId = "thread-st-untracked";
    insertSession({
      id: "st-untracked",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 6363,
      claude_session_id: "55555555-5555-5555-5555-555555555555",
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    effects.process.alivePids.add(6363);
    await effects.tmux.newSession(tmuxNameFor(threadId), "x");
    // Deliberately do NOT register in the in-memory map: has() === false.
    expect(await manager.livenessOf(threadId)).toBe("alive");

    const reply = await buildStatusReply(manager, threadId);
    expect(reply).toContain("見失って");
    expect(reply).not.toContain("稼働中です");
  });

  test("dead → reuses salvage wording (停止 + resume command)", async () => {
    const claudeId = "44444444-4444-4444-4444-444444444444";
    const threadId = "thread-st-dead";
    insertSession({
      id: "st-dead",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 6262,
      claude_session_id: claudeId,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    updateSessionStatus("st-dead", "stopped", "process_dead");

    const reply = await buildStatusReply(manager, threadId);
    expect(reply).toContain("停止しています");
    expect(reply).toContain(`/session resume ${claudeId}`);
  });

  test("unknown (no row) → no history", async () => {
    const reply = await buildStatusReply(manager, "thread-st-none");
    expect(reply).toContain("セッション履歴がありません");
  });
});
