import { test, expect, describe } from "bun:test";
import {
  executeSelfHealRestart,
  manualRestartGuidance,
  type SelfHealRestartDeps,
} from "../../src/session/self-heal-restart";

/**
 * Unit tests for the resume-backed auto-restart orchestration (Issue #244).
 * Every Discord / SessionManager side effect is injected, so these drive the
 * exact ordering and the degrade paths without a live session.
 *
 * Journey AC mapping:
 *   - item 1: critical → restart fires once, resumes into a NEW thread, links it
 *             from the old thread.
 *   - item 3: a failing restart (stop / create / resume) degrades to manual
 *             `/session resume <id>` guidance — never silent (silent failure = 0).
 *  (item 2 — the per-session cap that stops infinite restarts — is at the
 *   planner level: see self-heal.test.ts.)
 */

const SID = "11111111-2222-3333-4444-555555555555";

function makeDeps(
  overrides: Partial<SelfHealRestartDeps> = {}
): {
  deps: SelfHealRestartDeps;
  calls: { stop: number; create: number; resume: string[]; old: string[]; new: string[] };
} {
  const calls = { stop: 0, create: 0, resume: [] as string[], old: [] as string[], new: [] as string[] };
  const deps: SelfHealRestartDeps = {
    claudeSessionId: SID,
    tokens: 850_000,
    stopOld: async () => {
      calls.stop += 1;
    },
    createThread: async () => {
      calls.create += 1;
      return { id: "new-thread-1", mention: "<#new-thread-1>" };
    },
    resume: async (id) => {
      calls.resume.push(id);
    },
    notifyOld: async (m) => {
      calls.old.push(m);
    },
    notifyNew: async (_id, m) => {
      calls.new.push(m);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("executeSelfHealRestart (#244)", () => {
  test("AC item 1: success — stop → create → resume(new) → link old + welcome new", async () => {
    const { deps, calls } = makeDeps();
    const res = await executeSelfHealRestart(deps);

    expect(res.ok).toBe(true);
    expect(res.newThreadId).toBe("new-thread-1");
    expect(res.degraded).toBeUndefined();
    // ordering: stopped, created, resumed into the freshly created thread id.
    expect(calls.stop).toBe(1);
    expect(calls.create).toBe(1);
    expect(calls.resume).toEqual(["new-thread-1"]);
    // old thread got a link to the new thread; new thread got a welcome.
    expect(calls.old.length).toBe(1);
    expect(calls.old[0]).toContain("<#new-thread-1>");
    expect(calls.old[0]).toContain("#244");
    expect(calls.new.length).toBe(1);
  });

  test("AC item 3: resume failure (RW-047 timing) → degrade to manual /session resume, no throw", async () => {
    const { deps, calls } = makeDeps({
      resume: async () => {
        throw new Error("resume picker timed out");
      },
    });
    const res = await executeSelfHealRestart(deps);

    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.error).toContain("resume picker timed out");
    // The old thread was told exactly how to recover manually — silent failure = 0.
    expect(calls.old.length).toBe(1);
    expect(calls.old[0]).toContain(`/session resume ${SID}`);
    // No welcome was posted to a thread we failed to resume into.
    expect(calls.new.length).toBe(0);
  });

  test("AC item 3: stop failure → degrade, resume never attempted", async () => {
    const { deps, calls } = makeDeps({
      stopOld: async () => {
        throw new Error("tmux won't die");
      },
    });
    const res = await executeSelfHealRestart(deps);

    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(calls.create).toBe(0);
    expect(calls.resume).toEqual([]);
    expect(calls.old[0]).toContain(`/session resume ${SID}`);
  });

  test("AC item 3: thread-create failure → degrade, resume never attempted", async () => {
    const { deps, calls } = makeDeps({
      createThread: async () => {
        throw new Error("discord 503");
      },
    });
    const res = await executeSelfHealRestart(deps);

    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(calls.resume).toEqual([]);
    expect(calls.old[0]).toContain(`/session resume ${SID}`);
  });

  test("degrade guidance failing to post does NOT throw out of the relay tail", async () => {
    const { deps } = makeDeps({
      resume: async () => {
        throw new Error("boom");
      },
      notifyOld: async () => {
        throw new Error("discord down too");
      },
    });
    // Must resolve to a degraded result, not reject.
    const res = await executeSelfHealRestart(deps);
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
  });

  test("manualRestartGuidance always names the concrete resume command", () => {
    const g = manualRestartGuidance(SID, "テスト理由");
    expect(g).toContain(`/session resume ${SID}`);
    expect(g).toContain("テスト理由");
    expect(g).toContain("#244");
  });
});
