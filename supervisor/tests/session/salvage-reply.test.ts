// Isolate DB writes from the real sessions.db (mirrors tests/infra/db.test.ts).
// Must be set before any module that transitively loads infra/db is imported,
// so everything below uses dynamic import after the env is in place.
process.env.SUPERVISOR_DB_PATH = ":memory:";

import { test, expect, describe, beforeEach } from "bun:test";

const { insertSession, updateSessionStatus, getDb } = await import(
  "../../src/infra/db"
);
const { buildSalvageReply } = await import("../../src/bot");
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

  test("no DB row → reports no history and suggests /session start", () => {
    const reply = buildSalvageReply(manager, "thread-never-seen");
    expect(reply).toContain("セッション履歴がありません");
    expect(reply).toContain("/session start");
  });

  test("dead session with claude_session_id → offers a resume command", () => {
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

    const reply = buildSalvageReply(manager, "thread-dead");
    expect(reply).toContain("停止しています");
    expect(reply).toContain("process_dead");
    expect(reply).toContain(claudeId);
    expect(reply).toContain(`/session resume ${claudeId}`);
  });

  test("dead session without claude_session_id → degrades to /session start (pre-#167)", () => {
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

    const reply = buildSalvageReply(manager, "thread-noid");
    expect(reply).toContain("停止しています");
    expect(reply).toContain("未記録");
    expect(reply).toContain("/session start");
    expect(reply).not.toContain("/session resume");
  });

  // verdict === "alive": running row + pid alive + tmux session present, but
  // Supervisor lost in-memory tracking (e.g. restart). gemini review on #178.
  test("alive (process up, Supervisor lost tracking) with id → suggests resume with the id", () => {
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
    effects.tmux.newSession(tmuxNameFor(threadId), "x");
    expect(manager.livenessOf(threadId)).toBe("alive");

    const reply = buildSalvageReply(manager, threadId);
    expect(reply).toContain("管理を見失っています");
    expect(reply).toContain(`/session resume ${claudeId}`);
  });

  test("alive without id → suggests start (resume is not actionable without an id)", () => {
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
    effects.tmux.newSession(tmuxNameFor(threadId), "x");
    expect(manager.livenessOf(threadId)).toBe("alive");

    const reply = buildSalvageReply(manager, threadId);
    expect(reply).toContain("管理を見失っています");
    expect(reply).toContain("/session start");
    expect(reply).not.toContain("/session resume");
  });
});
