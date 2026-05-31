import { test, expect, describe, beforeEach, afterEach } from "bun:test";

/**
 * Manager-level tests for SessionManager.livenessOf (Issue #168). The
 * authoritative liveness check crosses DB `status='running'` against reality
 * (pid alive + tmux session present) so salvage responses and resume guards
 * cannot drift. Uses in-memory SQLite + fake adapters — no real tmux/process.
 *
 * AC coverage (issue #168):
 *   - AC-1: DB running + pid dead     → `dead`         (test: "DB running + pid 死 → dead")
 *   - AC-2: pid alive + tmux present  → `alive`        (test: "DB running + pid 生 + tmux 有 → alive")
 *   - AC-3: no DB row                 → `unknown`      (test: "DB 行なし → unknown")
 *   - AC-4: getSessionByThreadId (latest row) is covered by db.test.ts
 *           and exercised transitively via livenessOf returning the latest
 *           row's status (e.g. an older `stopped` row must not mask a newer
 *           `running` row).
 */

process.env.SUPERVISOR_DB_PATH = ":memory:";

const { SessionManager } = await import("../../src/session/manager");
const { createFakeEffects } = await import("../../src/session/adapters-fake");
const { insertSession, getDb } = await import("../../src/infra/db");

import type { FakeSessionEffects } from "../../src/session/adapters-fake";

// tmuxSessionName(threadId) = `claude-${threadId.slice(0, 12)}` (manager.ts).
// Kept inline so the tests fail loudly if the prefix or slice changes.
function tmuxNameFor(threadId: string): string {
  return `claude-${threadId.slice(0, 12)}`;
}

function rowFor(
  id: string,
  threadId: string,
  status: "running" | "stopped" | "stopping",
  pid: number | null,
  startedAt: string = new Date().toISOString()
) {
  return {
    id,
    channel_name: "team-salary",
    thread_id: threadId,
    project_dir: "/tmp/livenes-test",
    pid,
    claude_session_id: null,
    started_at: startedAt,
    last_activity_at: startedAt,
    status,
  };
}

describe("SessionManager.livenessOf (#168)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;

  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM sessions");
    effects = createFakeEffects();
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0 });
  });

  afterEach(async () => {
    await manager?.shutdownAll();
  });

  test("AC-3: DB 行なし → unknown", () => {
    expect(manager.livenessOf("thread-never-existed")).toBe("unknown");
  });

  test("AC-1: DB running + pid 死 → dead に矯正", () => {
    const threadId = "thread-zombie";
    insertSession(rowFor("z1", threadId, "running", 9999));
    // pid 9999 NOT in alivePids → fake reports dead.
    // tmux session NOT created → also missing. Either signal alone forces dead.
    expect(manager.livenessOf(threadId)).toBe("dead");
  });

  test("AC-2: pid 生存 + tmux 有 → alive", () => {
    const threadId = "thread-live";
    insertSession(rowFor("a1", threadId, "running", 4242));
    effects.process.alivePids.add(4242);
    effects.tmux.newSession(tmuxNameFor(threadId), "echo ok");
    expect(manager.livenessOf(threadId)).toBe("alive");
  });

  test("DB running + pid 生だが tmux 無し → dead (reality wins)", () => {
    // Defends the matrix: liveness=alive must require BOTH signals.
    const threadId = "thread-half-alive";
    insertSession(rowFor("h1", threadId, "running", 7777));
    effects.process.alivePids.add(7777);
    // tmux session deliberately NOT created
    expect(manager.livenessOf(threadId)).toBe("dead");
  });

  test("DB stopped → dead (DB authoritative when explicitly stopped)", () => {
    const threadId = "thread-stopped";
    insertSession(rowFor("s1", threadId, "stopped", 1234));
    // Even if pid+tmux happened to be reused/alive, an explicitly stopped row
    // means we should NOT call it alive — answer the stopped status.
    effects.process.alivePids.add(1234);
    effects.tmux.newSession(tmuxNameFor(threadId), "echo ok");
    expect(manager.livenessOf(threadId)).toBe("dead");
  });

  test("livenessOf reads the latest row (older stopped does not mask newer running)", () => {
    // Cross-test with AC-4: getSessionByThreadId picks `started_at DESC LIMIT 1`,
    // so an older stopped row must not flip a newer running row to dead.
    const threadId = "thread-rerun";
    insertSession(
      rowFor("old", threadId, "stopped", 1111, "2026-05-29T10:00:00.000Z")
    );
    insertSession(
      rowFor("new", threadId, "running", 2222, "2026-05-31T10:00:00.000Z")
    );
    effects.process.alivePids.add(2222);
    effects.tmux.newSession(tmuxNameFor(threadId), "echo ok");
    expect(manager.livenessOf(threadId)).toBe("alive");
  });
});
