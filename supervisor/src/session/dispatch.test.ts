import { test, expect, describe } from "bun:test";
import {
  parseDispatchCommand,
  runDispatch,
  DISPATCH_PREFIX,
  type DispatchSessionManager,
} from "./dispatch";

// #261 (corp #52 M2). The dispatch parser accepts a goal *selector* as the 3rd
// token and maps it to the slash command injected as the session's first prompt:
//   omitted / impl / no-template → /impl   (one raw Issue)
//   pdca                          → /pdca   (Epic-aware walk)
//   any playbook name (article …) → /<name> (generic, no dept names hardcoded)
// Malformed selectors are fail-closed. All orchestration deps are injected so
// these unit tests never touch a Discord gateway or a real SessionManager.

/** Helper: assert an ok parse and return it narrowed. */
function ok(content: string) {
  const parsed = parseDispatchCommand(content);
  if (parsed.kind !== "ok") {
    throw new Error(`expected ok, got ${parsed.kind}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

describe("parseDispatchCommand — selector → command mapping", () => {
  test("omitted 3rd token defaults to impl (backward compatible)", () => {
    expect(ok("/dispatch corp-dispatch-42 42").command).toBe("impl");
  });

  test("legacy `impl` token maps to impl", () => {
    expect(ok("/dispatch corp-dispatch-42 42 impl").command).toBe("impl");
  });

  test("`no-template` maps to impl (raw single Issue)", () => {
    expect(ok("/dispatch corp-dispatch-42 42 no-template").command).toBe("impl");
  });

  test("`pdca` maps to pdca (Epic walk)", () => {
    expect(ok("/dispatch corp-dispatch-341 341 pdca").command).toBe("pdca");
  });

  test("`article` maps to the same-named playbook command", () => {
    expect(ok("/dispatch corp-dispatch-243 243 article").command).toBe("article");
  });

  test("`devcycle` maps to the same-named playbook command", () => {
    expect(ok("/dispatch corp-dispatch-376 376 devcycle").command).toBe("devcycle");
  });

  test("an arbitrary slug playbook name passes through (generic, no hardcoded names)", () => {
    expect(ok("/dispatch corp-dispatch-7 7 release-train").command).toBe("release-train");
  });

  test("ok carries the validated branch and positive-integer issue number", () => {
    const parsed = ok("/dispatch corp-dispatch-243 243 article");
    expect(parsed.branch).toBe("corp-dispatch-243");
    expect(parsed.issueNumber).toBe(243);
  });
});

describe("parseDispatchCommand — fail-closed on malformed selectors", () => {
  for (const bad of ["Article", "art;rm", "-leading", "2fa", "with space?", "a_b", "../x"]) {
    test(`selector ${JSON.stringify(bad)} is rejected`, () => {
      const parsed = parseDispatchCommand(`/dispatch corp-dispatch-9 9 ${bad}`);
      expect(parsed.kind).toBe("error");
    });
  }
});

describe("parseDispatchCommand — non-dispatch / shape / number / branch guards", () => {
  test("non-/dispatch content is not_dispatch (relay falls through)", () => {
    expect(parseDispatchCommand("hello world").kind).toBe("not_dispatch");
  });

  test("`/dispatcher` is not the `/dispatch` token", () => {
    expect(parseDispatchCommand("/dispatcher foo 1").kind).toBe("not_dispatch");
  });

  test("`/impl 5` is not_dispatch (different command)", () => {
    expect(parseDispatchCommand("/impl 5").kind).toBe("not_dispatch");
  });

  test("too few tokens is error", () => {
    expect(parseDispatchCommand("/dispatch corp-dispatch-1").kind).toBe("error");
  });

  test("too many tokens is error", () => {
    expect(parseDispatchCommand("/dispatch corp-dispatch-1 1 pdca extra").kind).toBe("error");
  });

  test("non-integer issue number is error", () => {
    expect(parseDispatchCommand("/dispatch corp-dispatch-1 1.5").kind).toBe("error");
    expect(parseDispatchCommand("/dispatch corp-dispatch-1 abc").kind).toBe("error");
  });

  test("zero / non-positive issue number is error", () => {
    expect(parseDispatchCommand("/dispatch corp-dispatch-1 0").kind).toBe("error");
  });

  test("branch with a quote-breaking metacharacter is rejected (RW-045 guard)", () => {
    // assertShellSafeBranch rejects the chars that break a double-quoted shell
    // string the branch is interpolated into (`"`, backtick, `$`, `\`, controls).
    expect(parseDispatchCommand("/dispatch ba$d 1").kind).toBe("error");
  });

  test("branch with path traversal is rejected", () => {
    expect(parseDispatchCommand("/dispatch ../escape 1").kind).toBe("error");
  });

  test("DISPATCH_PREFIX is the literal `/dispatch`", () => {
    expect(DISPATCH_PREFIX).toBe("/dispatch");
  });
});

/** Records sendMessage calls; start/waitForInputReady succeed by default. */
function fakeSessionManager(): {
  mgr: DispatchSessionManager;
  injected: string[];
} {
  const injected: string[] = [];
  const mgr: DispatchSessionManager = {
    async start() {
      return {};
    },
    async waitForInputReady() {
      return true;
    },
    async sendMessage(_threadId: string, message: string) {
      injected.push(message);
      return {};
    },
  };
  return { mgr, injected };
}

describe("runDispatch — injects /<command> <issueNumber>", () => {
  test("article selector injects /article <N> as the first prompt", async () => {
    const { mgr, injected } = fakeSessionManager();
    const result = await runDispatch({
      config: {},
      branch: "corp-dispatch-243",
      issueNumber: 243,
      command: "article",
      sessionManager: mgr,
      createThread: async () => ({ id: "thread-1" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.threadId).toBe("thread-1");
      expect(result.injected).toBe("/article 243");
    }
    expect(injected).toEqual(["/article 243"]);
  });

  test("impl command injects /impl <N> (backward compatible default flow)", async () => {
    const { mgr, injected } = fakeSessionManager();
    const result = await runDispatch({
      config: {},
      branch: "corp-dispatch-42",
      issueNumber: 42,
      command: "impl",
      sessionManager: mgr,
      createThread: async () => ({ id: "thread-2" }),
    });
    expect(result.ok).toBe(true);
    expect(injected).toEqual(["/impl 42"]);
  });

  test("thread creation failure surfaces a tagged error (no silent fallback)", async () => {
    const { mgr } = fakeSessionManager();
    const result = await runDispatch({
      config: {},
      branch: "corp-dispatch-1",
      issueNumber: 1,
      command: "pdca",
      sessionManager: mgr,
      createThread: async () => {
        throw new Error("boom");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("thread");
  });
});
