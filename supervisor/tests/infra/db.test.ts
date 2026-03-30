import { test, expect, describe, beforeEach } from "bun:test";

// Use in-memory SQLite for CI
process.env.SUPERVISOR_DB_PATH = ":memory:";

// Reset module cache to pick up the env var
// Import after setting env
const { getDb, insertSession, updateSessionStatus, updateSessionActivity, getRunningSessions, getRunningSessionByThread, getRunningSessionsByChannel, getLastSessionByChannel } = await import("../../src/infra/db");

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
