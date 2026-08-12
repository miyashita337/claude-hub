import { describe, test, expect, spyOn } from "bun:test";
import { ResourceMonitor } from "../../src/session/resource-monitor";
import { AdmissionController } from "../../src/session/admission";
import type { SessionManager } from "../../src/session/manager";
import type { SessionInfo, StopReason } from "../../src/session/types";

/**
 * Issue #405 — test debt for `src/session/resource-monitor.ts`. Before this
 * file only `sampleLoad()` was exercised (from tests/session/admission.test.ts,
 * #295); the timer lifecycle and the whole `check()` teardown path had no test.
 *
 * `check()` is driven against the REAL `ps -o rss= -p <pid>` — no child_process
 * mock. Two properties make that deterministic:
 *   - the current test process is always a live pid with a real, small RSS, and
 *   - the over-limit branch is reached by lowering the injected ceiling
 *     (`maxMemoryMb: 0`) instead of faking the measurement.
 * So the exec, the `parseInt`, the KB→MB conversion and the comparison are all
 * the production ones. `ps -o rss= -p <pid>` is POSIX and behaves identically on
 * the macOS dev machine and the ubuntu-latest runner (exit 1 for an unknown
 * pid, which is what the error branch below relies on).
 */

function makeSession(over: Partial<SessionInfo>): SessionInfo {
  const now = new Date();
  return {
    id: "s1",
    channelName: "claude-hub",
    threadId: "t1",
    projectDir: "/repo",
    pid: process.pid,
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
  entriesCalls: () => number;
} {
  const stopCalls: Array<{ threadId: string; reason: StopReason }> = [];
  let entriesCalls = 0;
  const manager = {
    entries: () => {
      entriesCalls++;
      return sessions.entries();
    },
    // Mirrors the real SessionManager: stop() removes the session from the live
    // map, which is precisely the mid-loop mutation the Array.from() snapshot in
    // check() exists to survive (gemini PR #297 HIGH).
    stop: async (threadId: string, reason: StopReason) => {
      stopCalls.push({ threadId, reason });
      sessions.delete(threadId);
    },
  } as unknown as SessionManager;
  return { manager, stopCalls, entriesCalls: () => entriesCalls };
}

/** A pid that cannot be running: above the macOS pid ceiling, absent on Linux. */
const DEAD_PID = 999_999;

/**
 * Idle-load admission stub. The real controller samples the HOST's load average,
 * so on a busy dev machine every check() below would emit a "high load" WARN —
 * log noise unrelated to what these tests assert, and a hidden dependency on the
 * machine's state. The WARN path itself is covered in
 * tests/session/admission.test.ts (#295).
 */
function quietAdmission(): AdmissionController {
  return new AdmissionController({
    sampler: { sample: () => ({ load1: 0, cores: 8, freeMemRatio: 1 }) },
    mode: "observe",
  });
}

describe("ResourceMonitor.check (memory teardown)", () => {
  test("stops a session whose RSS exceeds the ceiling, with reason resource_limit", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t1", makeSession({ threadId: "t1", pid: process.pid })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Real `ps` on this process: any live process has RSS > 0 MB, so a 0 MB
      // ceiling makes the over-limit branch deterministic without faking `ps`.
      await new ResourceMonitor(manager, { maxMemoryMb: 0, admission: quietAdmission() }).check();
      expect(stopCalls).toEqual([{ threadId: "t1", reason: "resource_limit" }]);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]![0])).toContain("exceeded memory limit");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("leaves a session below the ceiling alone (no false teardown)", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["t1", makeSession({ threadId: "t1", pid: process.pid })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    // The default 2 GB ceiling is far above a bun test process's real RSS.
    await new ResourceMonitor(manager, { admission: quietAdmission() }).check();
    expect(stopCalls).toHaveLength(0);
    expect(sessions.has("t1")).toBe(true);
  });

  test("skips sessions with no pid before ever spawning ps", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["nopid", makeSession({ threadId: "nopid", pid: 0 })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    // maxMemoryMb 0 would stop ANY measured session, so a silent run proves the
    // `if (!session.pid) continue` guard short-circuited first.
    await new ResourceMonitor(manager, { maxMemoryMb: 0, admission: quietAdmission() }).check();
    expect(stopCalls).toHaveLength(0);
  });

  test("a dead pid (ps exits non-zero) is swallowed and does not abort the scan", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["dead", makeSession({ threadId: "dead", pid: DEAD_PID })],
      ["live", makeSession({ threadId: "live", pid: process.pid })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await new ResourceMonitor(manager, { maxMemoryMb: 0, admission: quietAdmission() }).check();
      // "dead" throws inside the try and is left to SessionManager cleanup;
      // "live" is still visited afterwards — the catch must not end the loop.
      expect(stopCalls).toEqual([
        { threadId: "live", reason: "resource_limit" },
      ]);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("iterates a snapshot, so stop() deleting entries mid-loop cannot skip a session", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["a", makeSession({ threadId: "a", pid: process.pid })],
      ["b", makeSession({ threadId: "b", pid: process.pid })],
      ["c", makeSession({ threadId: "c", pid: process.pid })],
    ]);
    const { manager, stopCalls } = makeManager(sessions);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await new ResourceMonitor(manager, { maxMemoryMb: 0, admission: quietAdmission() }).check();
      // Every session is over the 0 MB ceiling, so each must be stopped exactly
      // once even though each stop() deletes from the map being iterated.
      expect(stopCalls.map((c) => c.threadId).sort()).toEqual(["a", "b", "c"]);
      expect(sessions.size).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("samples system load on every pass (observe-only WARN, #295)", async () => {
    const { manager } = makeManager(new Map());
    const rm = new ResourceMonitor(manager, { admission: quietAdmission() });
    const sampleSpy = spyOn(rm, "sampleLoad");
    await rm.check();
    expect(sampleSpy).toHaveBeenCalledTimes(1);
  });
});

describe("ResourceMonitor timer lifecycle", () => {
  test("start() polls on the configured interval and stop() halts it", async () => {
    const { manager, entriesCalls } = makeManager(new Map());
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const rm = new ResourceMonitor(manager, { checkIntervalMs: 5, admission: quietAdmission() });
    try {
      rm.start();
      expect(String(logSpy.mock.calls[0]![0])).toContain("[ResourceMonitor] Started");

      // Each check() pass calls entries() exactly once, so it is an exact tick
      // counter. Poll for ticks rather than sleeping a fixed time.
      const deadline = Date.now() + 2000;
      while (entriesCalls() < 2 && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(entriesCalls()).toBeGreaterThanOrEqual(2);

      rm.stop();
      const afterStop = entriesCalls();
      await Bun.sleep(40); // >= 8 intervals: a live timer would tick again
      expect(entriesCalls()).toBe(afterStop);
    } finally {
      rm.stop();
      logSpy.mockRestore();
    }
  });

  test("stop() is safe before start() and idempotent", () => {
    const { manager } = makeManager(new Map());
    const rm = new ResourceMonitor(manager, { checkIntervalMs: 5, admission: quietAdmission() });
    expect(() => rm.stop()).not.toThrow();
    expect(() => rm.stop()).not.toThrow();
  });
});
