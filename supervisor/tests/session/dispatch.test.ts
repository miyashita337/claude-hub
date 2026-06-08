import { describe, test, expect } from "bun:test";
import {
  parseDispatchCommand,
  runDispatch,
  type DispatchSessionManager,
} from "../../src/session/dispatch";

/**
 * Issue #32 / S7 (dispatch transport): an allowed external source posts a
 * single message to a department channel:
 *
 *   /dispatch <branch> <issueNumber>
 *
 * `parseDispatchCommand` is the pure validator. It rejects anything that is
 * not the exact shape, a branch with shell metacharacters / path traversal
 * (RW-045 reuse), or a non-positive-integer issue number. A non-`/dispatch`
 * message yields `{ kind: "not_dispatch" }` so the caller falls through to the
 * normal relay path.
 */

describe("parseDispatchCommand", () => {
  test("parses a valid /dispatch command (mode defaults to impl)", () => {
    const r = parseDispatchCommand("/dispatch corp-dispatch-42 42");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.branch).toBe("corp-dispatch-42");
      expect(r.issueNumber).toBe(42);
      expect(r.command).toBe("impl");
    }
  });

  test("parses an explicit impl mode", () => {
    const r = parseDispatchCommand("/dispatch corp-dispatch-42 42 impl");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.issueNumber).toBe(42);
      expect(r.command).toBe("impl");
    }
  });

  test("parses a pdca mode (Epic dispatch)", () => {
    const r = parseDispatchCommand("/dispatch corp-dispatch-341 341 pdca");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.branch).toBe("corp-dispatch-341");
      expect(r.issueNumber).toBe(341);
      expect(r.command).toBe("pdca");
    }
  });

  test("an unrecognized mode token → error (fail-closed)", () => {
    const r = parseDispatchCommand("/dispatch corp-dispatch-42 42 bogus");
    expect(r.kind).toBe("error");
  });

  test("tolerates extra surrounding whitespace", () => {
    const r = parseDispatchCommand("   /dispatch   feat/foo   7   pdca   ");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.branch).toBe("feat/foo");
      expect(r.issueNumber).toBe(7);
      expect(r.command).toBe("pdca");
    }
  });

  test("non-/dispatch content → not_dispatch (falls through to relay)", () => {
    expect(parseDispatchCommand("hello world").kind).toBe("not_dispatch");
    expect(parseDispatchCommand("/impl 42").kind).toBe("not_dispatch");
    expect(parseDispatchCommand("/dispatcher x 1").kind).toBe("not_dispatch");
    expect(parseDispatchCommand("").kind).toBe("not_dispatch");
  });

  test("missing issue number → error (not silently a relay)", () => {
    const r = parseDispatchCommand("/dispatch some-branch");
    expect(r.kind).toBe("error");
  });

  test("too many arguments → error", () => {
    const r = parseDispatchCommand("/dispatch some-branch 42 pdca extra");
    expect(r.kind).toBe("error");
  });

  test("non-integer issue number → error", () => {
    expect(parseDispatchCommand("/dispatch some-branch abc").kind).toBe("error");
    expect(parseDispatchCommand("/dispatch some-branch 4.2").kind).toBe("error");
    expect(parseDispatchCommand("/dispatch some-branch 4x").kind).toBe("error");
  });

  test("zero / negative issue number → error", () => {
    expect(parseDispatchCommand("/dispatch some-branch 0").kind).toBe("error");
    expect(parseDispatchCommand("/dispatch some-branch -5").kind).toBe("error");
  });

  test("branch with shell metacharacters → error (RW-045)", () => {
    for (const bad of [
      '/dispatch foo"bar 1',
      "/dispatch foo`bar 1",
      "/dispatch foo$bar 1",
      "/dispatch foo\\bar 1",
    ]) {
      const r = parseDispatchCommand(bad);
      expect(r.kind).toBe("error");
    }
  });

  test("branch path traversal → error (RW-045)", () => {
    const r = parseDispatchCommand("/dispatch ../../etc 1");
    expect(r.kind).toBe("error");
  });

  test("error reason is identifier-free of the raw issue arg", () => {
    const r = parseDispatchCommand("/dispatch some-branch not-a-number");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      // The coarse message names the field, not the raw user-supplied token.
      expect(r.reason).not.toContain("not-a-number");
    }
  });

  test("a very large issue number is accepted as a positive integer", () => {
    const r = parseDispatchCommand("/dispatch b 1000000");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.issueNumber).toBe(1000000);
  });
});

/**
 * runDispatch must wait for the dept TUI to be input-ready BEFORE injecting the
 * `/impl` slash command. start() only waits for the PID, so an immediate inject
 * lets the Ink slash-picker eat the leading `/` and strands the text
 * un-submitted (RW-025 / RW-047, observed live as "impl <N>" stuck in the box).
 * These tests pin the ordering (start → waitForInputReady → sendMessage) and the
 * best-effort fallback (inject anyway on readiness timeout — never a silent drop).
 */
describe("runDispatch readiness ordering (RW-025/047)", () => {
  function recordingManager(ready: boolean): {
    sm: DispatchSessionManager;
    calls: string[];
  } {
    const calls: string[] = [];
    const sm: DispatchSessionManager = {
      start: async () => {
        calls.push("start");
        return {};
      },
      waitForInputReady: async () => {
        calls.push("waitForInputReady");
        return ready;
      },
      sendMessage: async (_threadId: string, message: string) => {
        calls.push(`send:${message}`);
        return {};
      },
    };
    return { sm, calls };
  }

  test("waits for input-ready, then injects /impl in order", async () => {
    const { sm, calls } = recordingManager(true);
    const r = await runDispatch({
      config: {},
      branch: "corp-dispatch-42",
      issueNumber: 42,
      command: "impl",
      sessionManager: sm,
      createThread: async () => ({ id: "thread-1" }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.threadId).toBe("thread-1");
      expect(r.injected).toBe("/impl 42");
    }
    // Critical: waitForInputReady is BETWEEN start and the /impl inject.
    expect(calls).toEqual(["start", "waitForInputReady", "send:/impl 42"]);
  });

  test("pdca mode injects /pdca (Epic-aware) after readiness", async () => {
    const { sm, calls } = recordingManager(true);
    const r = await runDispatch({
      config: {},
      branch: "corp-dispatch-341",
      issueNumber: 341,
      command: "pdca",
      sessionManager: sm,
      createThread: async () => ({ id: "thread-1" }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.injected).toBe("/pdca 341");
    expect(calls).toEqual(["start", "waitForInputReady", "send:/pdca 341"]);
  });

  test("injects anyway when readiness times out (best-effort, no silent drop)", async () => {
    const { sm, calls } = recordingManager(false);
    const r = await runDispatch({
      config: {},
      branch: "b",
      issueNumber: 7,
      command: "impl",
      sessionManager: sm,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["start", "waitForInputReady", "send:/impl 7"]);
  });

  test("a readiness probe error does not abort the dispatch (still injects)", async () => {
    const calls: string[] = [];
    const sm: DispatchSessionManager = {
      start: async () => {
        calls.push("start");
        return {};
      },
      waitForInputReady: async () => {
        calls.push("waitForInputReady");
        throw new Error("probe boom");
      },
      sendMessage: async (_t: string, message: string) => {
        calls.push(`send:${message}`);
        return {};
      },
    };
    const r = await runDispatch({
      config: {},
      branch: "b",
      issueNumber: 9,
      command: "impl",
      sessionManager: sm,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["start", "waitForInputReady", "send:/impl 9"]);
  });
});
