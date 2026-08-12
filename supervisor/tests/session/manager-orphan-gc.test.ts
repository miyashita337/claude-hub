import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import {
  SessionManager,
  ORPHAN_TMUX_REAP_REASON,
} from "../../src/session/manager";
import {
  createFakeEffects,
  type FakeSessionEffects,
} from "../../src/session/adapters-fake";
import {
  getDb,
  insertSession,
  getSessionByThreadId,
} from "../../src/infra/db";

/**
 * Issue #246 — orphan GC blind spot.
 *
 * `recoverFromDb` only walked DB `status='running'` rows, so the
 * **DB=stopped + tmux alive** combination (produced by `watchTmuxSession`'s
 * tmux_exited branch, which marks the row stopped but deliberately does not
 * kill tmux) was reaped by nobody: absent from the in-memory map the reapers
 * iterate, and absent from the restart sweep. These tests pin the sweep that
 * closes it, plus the safety rules that keep it from killing anything it does
 * not positively own.
 *
 * The DB is isolated by supervisor/bunfig.toml's `[test].preload`
 * (tests/setup/db-isolation.ts), so these rows never touch the real
 * sessions.db.
 */
describe("SessionManager orphan tmux GC (#246)", () => {
  let manager: SessionManager | undefined;
  let effects: FakeSessionEffects;

  // The tmux name only keeps threadId.slice(0, 12), so these two must differ
  // *within* the first 12 characters or they would collide onto one session.
  const ORPHAN_THREAD = "911100000000111";
  const RUNNING_THREAD = "922200000000222";
  const orphanTmux = SessionManager.tmuxSessionNameFor(ORPHAN_THREAD);
  const runningTmux = SessionManager.tmuxSessionNameFor(RUNNING_THREAD);

  function seedSession(
    id: string,
    threadId: string,
    status: string,
    stoppedReason?: string,
    startedAt: string = new Date().toISOString()
  ): void {
    insertSession({
      id,
      channel_name: "test-channel",
      thread_id: threadId,
      project_dir: "/tmp/orphan-gc-test",
      pid: null,
      claude_session_id: null,
      started_at: startedAt,
      last_activity_at: startedAt,
      status,
    });
    if (stoppedReason) {
      getDb()
        .prepare(`UPDATE sessions SET stopped_reason = ? WHERE id = ?`)
        .run(stoppedReason, id);
    }
  }

  /** Construct the manager (its constructor kicks off recovery) and await it. */
  async function recover(): Promise<void> {
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0 });
    await manager.recovery;
  }

  beforeEach(() => {
    getDb().exec("DELETE FROM sessions");
    effects = createFakeEffects();
    manager = undefined;
  });

  afterEach(async () => {
    await manager?.shutdownAll();
  });

  test("reaps a tmux session whose DB row is already stopped", async () => {
    seedSession("orphan-1", ORPHAN_THREAD, "stopped", "tmux_exited");
    await effects.tmux.newSession(orphanTmux, "claude");

    await recover();

    expect(await effects.tmux.hasSession(orphanTmux)).toBe(false);
    expect(getSessionByThreadId(ORPHAN_THREAD)?.stopped_reason).toBe(
      ORPHAN_TMUX_REAP_REASON
    );
    // Distinct from OrphanDispatchReaper's idle-dispatch reap, so the DB shows
    // which path retired the session.
    expect(ORPHAN_TMUX_REAP_REASON).toBe("orphan_tmux_reaped");
  });

  test("leaves a prefixed tmux session with no owning DB row alone", async () => {
    // Nothing seeded: no row claims this threadId prefix. Killing on a name
    // match alone would let the GC reap a session it cannot prove is ours.
    const unknown = SessionManager.tmuxSessionNameFor("900000000000999");
    await effects.tmux.newSession(unknown, "claude");

    await recover();

    expect(await effects.tmux.hasSession(unknown)).toBe(true);
  });

  test("never touches tmux sessions outside the supervisor's name prefix", async () => {
    seedSession("orphan-2", ORPHAN_THREAD, "stopped", "tmux_exited");
    await effects.tmux.newSession("my-own-editor", "vim");

    await recover();

    expect(await effects.tmux.hasSession("my-own-editor")).toBe(true);
  });

  test("running rows keep the supervisor_restart path, not orphan_reaped", async () => {
    seedSession("running-1", RUNNING_THREAD, "running");
    await effects.tmux.newSession(runningTmux, "claude");

    await recover();

    // Killed by the pre-existing restart loop — the sweep must not claim it and
    // must not double-kill it under a different reason.
    expect(await effects.tmux.hasSession(runningTmux)).toBe(false);
    expect(getSessionByThreadId(RUNNING_THREAD)?.stopped_reason).toBe(
      "supervisor_restart"
    );
  });

  test("skips a thread whose latest row is running even when an older row is stopped", async () => {
    // Same thread restarted: the stale stopped row must not make the sweep
    // treat the live session as an orphan. Timestamps are explicit because
    // "latest row" is ordered by started_at.
    seedSession(
      "restarted-old",
      RUNNING_THREAD,
      "stopped",
      "tmux_exited",
      "2026-01-01T00:00:00.000Z"
    );
    seedSession(
      "restarted-new",
      RUNNING_THREAD,
      "running",
      undefined,
      "2026-01-02T00:00:00.000Z"
    );
    await effects.tmux.newSession(runningTmux, "claude");

    await recover();

    const rows = getDb()
      .prepare(`SELECT id, stopped_reason FROM sessions WHERE thread_id = ?`)
      .all(RUNNING_THREAD) as { id: string; stopped_reason: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r.stopped_reason]));
    expect(byId.get("restarted-new")).toBe("supervisor_restart");
    // The stale row is left untouched — it was not re-stamped as an orphan.
    expect(byId.get("restarted-old")).toBe("tmux_exited");
  });

  test("reaps nothing when tmux cannot be listed (empty list degrades safely)", async () => {
    seedSession("orphan-3", ORPHAN_THREAD, "stopped", "tmux_exited");
    // listSessions() returns [] both for "no server" and for a failed/timed-out
    // call (see TmuxAdapter.listSessions). The row must be left exactly as it
    // was rather than being recorded as reaped.
    effects.tmux.listSessions = async () => [];

    await recover();

    expect(getSessionByThreadId(ORPHAN_THREAD)?.stopped_reason).toBe(
      "tmux_exited"
    );
  });
});
