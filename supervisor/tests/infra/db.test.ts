import { test, expect, describe, beforeEach } from "bun:test";

// Use in-memory SQLite for CI
process.env.SUPERVISOR_DB_PATH = ":memory:";

// Reset module cache to pick up the env var
// Import after setting env
const { getDb, insertSession, updateSessionStatus, updateSessionActivity, getRunningSessions, getRunningSessionByThread, getRunningSessionsByChannel, getLastSessionByChannel, getSessionByClaudeSessionId, getSessionByThreadId } = await import("../../src/infra/db");

describe("infra/db (in-memory)", () => {
  beforeEach(() => {
    // Clear all rows between tests
    const db = getDb();
    db.exec("DELETE FROM sessions");
    // Verify clean state
    const count = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any;
    if (count.c !== 0) throw new Error(`DB not clean: ${count.c} rows remaining`);
  });

  test("insertSession and getRunningSessions", () => {
    insertSession({
      id: "test-1",
      channel_name: "team-salary",
      thread_id: "thread-1",
      project_dir: "/tmp/test",
      pid: 1234,
      claude_session_id: null,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });

    const rows = getRunningSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("test-1");
    expect(rows[0]!.channel_name).toBe("team-salary");
    expect(rows[0]!.thread_id).toBe("thread-1");
  });

  test("getSessionByClaudeSessionId returns the most recent matching row (#161)", () => {
    const claudeId = "3139aa23-fe2a-485a-831a-2209081f9935";
    // Older row with the same claude session id.
    insertSession({
      id: "resume-old",
      channel_name: "team-salary",
      thread_id: "thread-old",
      project_dir: "/Users/x/team_salary",
      pid: 100,
      claude_session_id: claudeId,
      started_at: "2026-05-24T10:00:00.000Z",
      last_activity_at: "2026-05-24T10:00:00.000Z",
      status: "stopped",
    });
    // Newer row with the same claude session id (e.g. a prior resume).
    insertSession({
      id: "resume-new",
      channel_name: "team-salary",
      thread_id: "thread-new",
      project_dir: "/Users/x/team_salary",
      pid: 200,
      claude_session_id: claudeId,
      started_at: "2026-05-25T10:00:00.000Z",
      last_activity_at: "2026-05-25T10:00:00.000Z",
      status: "stopped",
    });

    const found = getSessionByClaudeSessionId(claudeId);
    expect(found?.id).toBe("resume-new"); // ORDER BY started_at DESC
    expect(found?.project_dir).toBe("/Users/x/team_salary");

    // bun:sqlite .get() returns null (not undefined) for no match; the handler
    // treats both as "not found" via `if (!row)`.
    expect(getSessionByClaudeSessionId("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  test("getSessionByThreadId returns the latest row (started_at DESC LIMIT 1) regardless of status (#168)", () => {
    const threadId = "thread-resumed-twice";
    // First run on this thread, since stopped.
    insertSession({
      id: "first",
      channel_name: "team-salary",
      thread_id: threadId,
      project_dir: "/Users/x/team_salary",
      pid: 100,
      claude_session_id: null,
      started_at: "2026-05-29T10:00:00.000Z",
      last_activity_at: "2026-05-29T10:00:00.000Z",
      status: "stopped",
    });
    // Second run on the same thread, currently running.
    insertSession({
      id: "second",
      channel_name: "team-salary",
      thread_id: threadId,
      project_dir: "/Users/x/team_salary",
      pid: 200,
      claude_session_id: null,
      started_at: "2026-05-31T10:00:00.000Z",
      last_activity_at: "2026-05-31T10:00:00.000Z",
      status: "running",
    });

    // AC: latest by started_at, irrespective of status.
    const found = getSessionByThreadId(threadId);
    expect(found?.id).toBe("second");
    expect(found?.status).toBe("running");

    // No row → null (bun:sqlite convention, treated as "not found" by callers).
    expect(getSessionByThreadId("thread-never-seen")).toBeNull();
  });

  test("updateSessionStatus changes status and reason", () => {
    insertSession({
      id: "test-2",
      channel_name: "oci-develop",
      thread_id: "thread-2",
      project_dir: "/tmp/test",
      pid: 5678,
      claude_session_id: null,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });

    updateSessionStatus("test-2", "stopped", "manual");

    const rows = getRunningSessions();
    expect(rows).toHaveLength(0); // No longer running

    const db = getDb();
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("test-2") as any;
    expect(row.status).toBe("stopped");
    expect(row.stopped_reason).toBe("manual");
  });

  test("updateSessionActivity updates timestamp", () => {
    const oldTime = "2026-01-01T00:00:00.000Z";
    insertSession({
      id: "test-3",
      channel_name: "dev-tool",
      thread_id: "thread-3",
      project_dir: "/tmp/test",
      pid: 9999,
      claude_session_id: null,
      started_at: oldTime,
      last_activity_at: oldTime,
      status: "running",
    });

    updateSessionActivity("test-3");

    const db = getDb();
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("test-3") as any;
    expect(row.last_activity_at).not.toBe(oldTime);
  });

  test("getRunningSessionByThread returns correct row", () => {
    insertSession({
      id: "test-4",
      channel_name: "team-salary",
      thread_id: "thread-find-me",
      project_dir: "/tmp/test",
      pid: 1111,
      claude_session_id: null,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });

    const found = getRunningSessionByThread("thread-find-me");
    expect(found).toBeDefined();
    expect(found!.id).toBe("test-4");

    const notFound = getRunningSessionByThread("thread-does-not-exist-xyz");
    expect(notFound).toBeFalsy();
  });

  test("getRunningSessionsByChannel filters by channel", () => {
    insertSession({
      id: "s1", channel_name: "team-salary", thread_id: "t1",
      project_dir: "/tmp", pid: 1, claude_session_id: null,
      started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), status: "running",
    });
    insertSession({
      id: "s2", channel_name: "team-salary", thread_id: "t2",
      project_dir: "/tmp", pid: 2, claude_session_id: null,
      started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), status: "running",
    });
    insertSession({
      id: "s3", channel_name: "oci-develop", thread_id: "t3",
      project_dir: "/tmp", pid: 3, claude_session_id: null,
      started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), status: "running",
    });

    const salaryRows = getRunningSessionsByChannel("team-salary");
    expect(salaryRows).toHaveLength(2);

    const ociRows = getRunningSessionsByChannel("oci-develop");
    expect(ociRows).toHaveLength(1);
  });

  test("getRunningSessions returns only running rows", () => {
    insertSession({
      id: "running-1", channel_name: "ch1", thread_id: "t1",
      project_dir: "/tmp", pid: 1, claude_session_id: null,
      started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), status: "running",
    });
    insertSession({
      id: "stopped-1", channel_name: "ch2", thread_id: "t2",
      project_dir: "/tmp", pid: 2, claude_session_id: null,
      started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), status: "running",
    });
    updateSessionStatus("stopped-1", "stopped", "manual");

    const rows = getRunningSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("running-1");
  });
});
