import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import {
  SessionManager,
  ORPHAN_TMUX_REAP_REASON,
} from "../../src/session/manager";
import type { ChannelConfig } from "../../src/config/channels";
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

  test("does not reap a session that is mid-start while recovery runs (PR #413 review)", async () => {
    // Recovery is kicked off by the constructor and nobody awaits it, so a
    // /session start can overlap it. launchStart creates the tmux session before
    // it publishes to `sessions` / inserts the DB row, so during that window the
    // only thing marking the session as ours is `pendingStarts`. With an older
    // stopped row on the same thread present, a sweep that ignored pendingStarts
    // would kill the session the user just started.
    seedSession("previous-run", ORPHAN_THREAD, "stopped", "tmux_exited");

    // Gate A holds the sweep inside listSessions; gate B holds launchStart at
    // its PID poll — i.e. after newSession, before sessions.set.
    let releaseSweep!: () => void;
    const sweepGate = new Promise<void>((r) => (releaseSweep = r));
    let releasePid!: () => void;
    const pidGate = new Promise<void>((r) => (releasePid = r));

    const realListSessions = effects.tmux.listSessions.bind(effects.tmux);
    effects.tmux.listSessions = async () => {
      await sweepGate;
      return realListSessions();
    };
    const realGetPid = effects.tmux.getPid.bind(effects.tmux);
    effects.tmux.getPid = async (name: string) => {
      await pidGate;
      return realGetPid(name);
    };

    const dir = resolve(tmpdir(), `orphan-gc-start-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const config: ChannelConfig = {
      channelName: "test-channel",
      dir,
      displayName: "Test Channel",
    };

    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0 });
    const started = manager.start(config, ORPHAN_THREAD);

    // Let start() get past newSession and park on the PID poll.
    while (!(await realListSessions()).includes(orphanTmux)) {
      await new Promise((r) => setTimeout(r, 5));
    }

    releaseSweep();
    await manager.recovery;

    // The mid-start session survived, and the stale row was not re-stamped.
    expect(await effects.tmux.hasSession(orphanTmux)).toBe(true);
    expect(getSessionByThreadId(ORPHAN_THREAD)?.stopped_reason).toBe(
      "tmux_exited"
    );

    releasePid();
    await started;
    expect(await effects.tmux.hasSession(orphanTmux)).toBe(true);
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
