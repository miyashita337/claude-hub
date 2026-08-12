import { describe, test, expect } from "bun:test";
import { Reaper, resolveIdleTimeoutMs } from "../../src/session/reaper";
import {
  SESSION_IDLE_DEFAULT_MS,
  SESSION_IDLE_BACKSTOP_MS,
} from "../../src/config/channels";
import type { SessionInfo, StopReason } from "../../src/session/types";
import type { SessionManager } from "../../src/session/manager";
import type { Client } from "discord.js";

/**
 * Phase 5b / #293 (Epic #292 AC-1): the interactive idle reaper threshold is
 * env-configurable with a shortened default, the old 30-day value is a hard
 * backstop, and teardown leaves a resume導線.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("resolveIdleTimeoutMs", () => {
  test("defaults to the shortened 6h default", () => {
    expect(resolveIdleTimeoutMs({})).toBe(SESSION_IDLE_DEFAULT_MS);
    expect(SESSION_IDLE_DEFAULT_MS).toBe(6 * HOUR);
  });

  test("honours a valid env override", () => {
    expect(resolveIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: String(3 * HOUR) })).toBe(
      3 * HOUR,
    );
  });

  test("restores the old 30-day behaviour when env is set to 30d (AC-1)", () => {
    expect(resolveIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: String(30 * DAY) })).toBe(
      30 * DAY,
    );
  });

  test("caps at the 30-day hard backstop even for a huge env value", () => {
    expect(
      resolveIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: String(9999 * DAY) }),
    ).toBe(SESSION_IDLE_BACKSTOP_MS);
    expect(SESSION_IDLE_BACKSTOP_MS).toBe(30 * DAY);
  });

  test("falls back to the default for invalid / non-positive env", () => {
    expect(resolveIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: "abc" })).toBe(
      SESSION_IDLE_DEFAULT_MS,
    );
    expect(resolveIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: "0" })).toBe(
      SESSION_IDLE_DEFAULT_MS,
    );
    expect(resolveIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: "-5" })).toBe(
      SESSION_IDLE_DEFAULT_MS,
    );
  });
});

describe("Reaper.buildIdleNotice", () => {
  test("includes a /session resume line when a claude session id is present", () => {
    const notice = Reaper.buildIdleNotice(7 * HOUR, {
      claudeSessionId: "abc-123",
      branch: "feat/x",
    });
    expect(notice).toContain("自動終了");
    expect(notice).toContain("/session resume abc-123");
  });

  test("falls back to /session start guidance when no claude session id", () => {
    const notice = Reaper.buildIdleNotice(7 * HOUR, { branch: "corp-dispatch-9" });
    expect(notice).toContain("/session start corp-dispatch-9");
    expect(notice).not.toContain("/session resume");
  });
});

function makeSession(over: Partial<SessionInfo> & { threadId: string }): SessionInfo {
  const now = new Date();
  return {
    id: over.threadId,
    channelName: "chan",
    projectDir: "/repo",
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

describe("Reaper.check", () => {
  test("reaps a session idle beyond the configured threshold and posts resume導線", async () => {
    const NOW = 1000 * HOUR;
    const sessions = new Map<string, SessionInfo>([
      [
        "idle",
        makeSession({
          threadId: "idle",
          claudeSessionId: "sess-idle",
          lastActivityAt: new Date(NOW - 7 * HOUR), // idle 7h > 6h default
        }),
      ],
      [
        "fresh",
        makeSession({
          threadId: "fresh",
          lastActivityAt: new Date(NOW - 1 * HOUR), // idle 1h < 6h
        }),
      ],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const sent: string[] = [];
    const thread = {
      isThread: () => true,
      name: "🟢 x",
      send: async (m: string) => {
        sent.push(m);
      },
      setName: async () => {},
      setArchived: async () => {},
    };
    const client = {
      channels: { cache: { get: () => thread }, fetch: async () => thread },
    } as unknown as Client;

    const reaper = new Reaper(manager, client, {
      idleTimeoutMs: 6 * HOUR,
      now: () => NOW,
    });
    await reaper.check();

    // Only the idle-past-threshold session is reaped.
    expect(stopCalls).toEqual([{ threadId: "idle", reason: "idle_timeout" }]);
    // The teardown notice carried the resume導線 with the captured session id.
    expect(sent.join("\n")).toContain("/session resume sess-idle");
  });

  test("reaps EVERY idle session even though stop() deletes from the live map mid-iteration (PR #297 HIGH)", async () => {
    const NOW = 1000 * HOUR;
    // All three are idle past the threshold. makeManager.stop deletes each from
    // the map, so without the Array.from snapshot the live-iterator could skip
    // entries; the snapshot guarantees all three are processed.
    const sessions = new Map<string, SessionInfo>(
      ["a", "b", "c"].map((id) => [
        id,
        makeSession({ threadId: id, lastActivityAt: new Date(NOW - 8 * HOUR) }),
      ]),
    );
    const { manager, stopCalls } = makeManager(sessions);
    const thread = {
      isThread: () => true,
      name: "🟢 x",
      send: async () => {},
      setName: async () => {},
      setArchived: async () => {},
    };
    const client = {
      channels: { cache: { get: () => thread }, fetch: async () => thread },
    } as unknown as Client;

    const reaper = new Reaper(manager, client, {
      idleTimeoutMs: 6 * HOUR,
      now: () => NOW,
    });
    await reaper.check();

    expect(stopCalls.map((c) => c.threadId).sort()).toEqual(["a", "b", "c"]);
    expect(sessions.size).toBe(0); // all removed
  });
});

/**
 * Issue #416 (Journey AC #4): with the ask wait at 5h against a 6h idle
 * horizon, a session that was already quiet for an hour when the question was
 * asked would be reaped while the 会長 was still deciding — destroying the
 * session the answer was meant for.
 */
describe("Reaper.check — sessions awaiting an AskUserQuestion answer", () => {
  test("spares an over-threshold session that is waiting on the user, reaps its neighbour", async () => {
    const NOW = 1000 * HOUR;
    const sessions = new Map<string, SessionInfo>([
      [
        "asking",
        makeSession({
          threadId: "asking",
          lastActivityAt: new Date(NOW - 8 * HOUR), // well past the horizon
        }),
      ],
      [
        "plain-idle",
        makeSession({
          threadId: "plain-idle",
          lastActivityAt: new Date(NOW - 8 * HOUR),
        }),
      ],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const thread = {
      isThread: () => true,
      name: "🟢 x",
      send: async () => {},
      setName: async () => {},
      setArchived: async () => {},
    };
    const client = {
      channels: { cache: { get: () => thread }, fetch: async () => thread },
    } as unknown as Client;

    const reaper = new Reaper(manager, client, {
      idleTimeoutMs: 6 * HOUR,
      now: () => NOW,
      isAwaitingAsk: (threadId) => threadId === "asking",
    });
    await reaper.check();

    // Only the sparing is conditional — an equally idle session with no
    // outstanding question is still reaped, so this is not a blanket reprieve.
    expect(stopCalls).toEqual([
      { threadId: "plain-idle", reason: "idle_timeout" },
    ]);
    expect(sessions.has("asking")).toBe(true);
  });

  test("reaps normally once the question has been answered", async () => {
    const NOW = 1000 * HOUR;
    const sessions = new Map<string, SessionInfo>([
      ["answered", makeSession({ threadId: "answered", lastActivityAt: new Date(NOW - 8 * HOUR) })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const thread = {
      isThread: () => true,
      name: "🟢 x",
      send: async () => {},
      setName: async () => {},
      setArchived: async () => {},
    };
    const client = {
      channels: { cache: { get: () => thread }, fetch: async () => thread },
    } as unknown as Client;

    const reaper = new Reaper(manager, client, {
      idleTimeoutMs: 6 * HOUR,
      now: () => NOW,
      isAwaitingAsk: () => false, // ask resolved before this scan
    });
    await reaper.check();

    expect(stopCalls).toEqual([{ threadId: "answered", reason: "idle_timeout" }]);
  });
});
