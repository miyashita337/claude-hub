import { describe, test, expect } from "bun:test";
import {
  selectReapableDispatch,
  type ReapableSession,
} from "../../src/session/orphan-dispatch-reaper";
import { GoalWatcher } from "../../src/session/goal-watcher";
import type { SessionInfo, StopReason } from "../../src/session/types";
import type { SessionManager } from "../../src/session/manager";
import type { Client } from "discord.js";

/**
 * Epic #285 Phase 2 / #288: the tmux-shaped liveness machinery must not touch a
 * headless dispatch session. A headless session self-terminates on its child's
 * exit (SessionManager.finishHeadless owns teardown) and has no relay to refresh
 * lastActivityAt, so idle-based orphan reaping and label-driven goal stopping
 * would both fire wrongly. Both must skip `executor:"headless"`.
 */

const HOUR = 60 * 60 * 1000;

describe("selectReapableDispatch (orphan reaper) skips headless", () => {
  const now = 1_000 * HOUR;
  const idleThresholdMs = 48 * HOUR;
  const stale = new Date(now - 60 * HOUR); // well past the horizon

  test("a headless dispatch session is never orphan-reaped, even when long-idle", () => {
    const entries = new Map<string, ReapableSession>([
      [
        "tmux-42",
        { branch: "corp-dispatch-42", status: "running", lastActivityAt: stale },
      ],
      [
        "headless-99",
        {
          branch: "corp-dispatch-99",
          status: "running",
          lastActivityAt: stale,
          executor: "headless",
        },
      ],
    ]);
    const picked = selectReapableDispatch(entries, { idleThresholdMs, now });
    const ids = picked.map((p) => p.threadId);
    // The tmux orphan is reaped; the headless one is spared.
    expect(ids).toContain("tmux-42");
    expect(ids).not.toContain("headless-99");
  });
});

function makeSession(over: Partial<SessionInfo> & { threadId: string }): SessionInfo {
  const now = new Date();
  return {
    id: over.threadId,
    channelName: "convert-service",
    projectDir: "/repo/.claude/worktrees/corp-dispatch-1",
    pid: 1,
    process: null as unknown as SessionInfo["process"],
    startedAt: now,
    lastActivityAt: now,
    status: "running",
    ...over,
  } as SessionInfo;
}

function makeManager(sessions: Map<string, SessionInfo>): {
  manager: SessionManager;
  stopCalls: Array<{ threadId: string; reason: StopReason }>;
} {
  const stopCalls: Array<{ threadId: string; reason: StopReason }> = [];
  const manager = {
    entries: () => sessions.entries(),
    stop: async (threadId: string, reason: StopReason) => {
      stopCalls.push({ threadId, reason });
      sessions.delete(threadId);
    },
  } as unknown as SessionManager;
  return { manager, stopCalls };
}

describe("GoalWatcher skips headless dispatch sessions", () => {
  test("a done-labelled tmux session stops, a done-labelled headless one does not", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["tmux-1", makeSession({ threadId: "tmux-1", branch: "corp-dispatch-1" })],
      [
        "headless-1",
        makeSession({
          threadId: "headless-1",
          branch: "corp-dispatch-2",
          executor: "headless",
        }),
      ],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const client = {
      channels: { cache: { get: () => undefined }, fetch: async () => undefined },
    } as unknown as Client;

    const watcher = new GoalWatcher(manager, client, {
      // Both issues carry `done`; grace 0 so a non-skipped session stops on the
      // second tick (first opens the window, second elapses it).
      fetchIssueLabels: async () => ["done"],
      graceMs: 0,
      now: () => Date.now(),
    });

    await watcher.check();
    await watcher.check();

    const stopped = stopCalls.map((c) => c.threadId);
    expect(stopped).toContain("tmux-1");
    expect(stopped).not.toContain("headless-1");
  });
});
