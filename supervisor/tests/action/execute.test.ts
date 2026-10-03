import { test, expect, describe } from "bun:test";
import {
  executeAction,
  resolveTmuxSessionForTarget,
  isActionAllowed,
  ALLOWED_ACTIONS,
  ONE_TAP_COMPACT_INTENT,
  realpathOrResolve,
  type ExecuteDeps,
  type SessionResolveDeps,
} from "../../src/action/execute";

describe("action/execute allowlist", () => {
  test("only compact and the permission answers are allowed", () => {
    expect(isActionAllowed("compact")).toBe(true);
    expect(isActionAllowed("perm-allow")).toBe(true);
    expect(isActionAllowed("perm-deny")).toBe(true);
    expect(isActionAllowed("rm-rf")).toBe(false);
    expect(isActionAllowed("COMPACT")).toBe(false);
    expect(isActionAllowed("")).toBe(false);
    expect([...ALLOWED_ACTIONS]).toEqual(["compact", "perm-allow", "perm-deny"]);
  });
});

// Issue #488: one-tap approve/deny for a waiting PermissionRequest hook
describe("action/execute perm-allow / perm-deny", () => {
  const base: ExecuteDeps = {
    resolveSession: async () => null,
    send: async () => {
      throw new Error("must not send keys for a permission answer");
    },
  };

  test("writes allow / deny for a pending request", async () => {
    const written: [string, string][] = [];
    const deps: ExecuteDeps = {
      ...base,
      writePermDecision: async (id, d) => {
        written.push([id, d]);
        return true;
      },
    };
    expect((await executeAction("perm-allow", "req-1234abcd", deps)).ok).toBe(true);
    expect((await executeAction("perm-deny", "req-5678abcd", deps)).ok).toBe(true);
    expect(written).toEqual([
      ["req-1234abcd", "allow"],
      ["req-5678abcd", "deny"],
    ]);
  });

  test("unsafe ids never reach the filesystem", async () => {
    let called = false;
    const deps: ExecuteDeps = {
      ...base,
      writePermDecision: async () => {
        called = true;
        return true;
      },
    };
    for (const bad of ["../../etc/x", "a/b", "short", "id.with.dots", ""]) {
      const r = await executeAction("perm-allow", bad, deps);
      expect(r.ok).toBe(false);
    }
    expect(called).toBe(false);
  });

  test("no pending request (timed out / unknown) → target_not_found", async () => {
    const r = await executeAction("perm-allow", "req-1234abcd", {
      ...base,
      writePermDecision: async () => false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("target_not_found");
  });

  test("a second answer for the same request is reported, not swallowed", async () => {
    const r = await executeAction("perm-deny", "req-1234abcd", {
      ...base,
      writePermDecision: async () => {
        throw new Error("EEXIST");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("send_failed");
  });
});

describe("action/execute executeAction", () => {
  function deps(overrides: Partial<ExecuteDeps> = {}): ExecuteDeps & {
    sent: { session: string; text: string }[];
  } {
    const sent: { session: string; text: string }[] = [];
    return {
      resolveSession: async () => "claude-abcdef012345",
      send: async (session, text) => {
        sent.push({ session, text });
      },
      sent,
      ...overrides,
    };
  }

  test("compact resolves the session and sends /compact <intent>", async () => {
    const d = deps();
    const result = await executeAction("compact", "/Users/x/wt/issue-441", d);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.tmuxSession).toBe("claude-abcdef012345");
    expect(result.sentText).toBe(`/compact ${ONE_TAP_COMPACT_INTENT}`);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.session).toBe("claude-abcdef012345");
    expect(d.sent[0]!.text).toBe(`/compact ${ONE_TAP_COMPACT_INTENT}`);
  });

  test("unresolved target returns target_not_found and does not send", async () => {
    const d = deps({ resolveSession: async () => null });
    const result = await executeAction("compact", "/Users/x/gone", d);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("target_not_found");
    expect(d.sent).toHaveLength(0);
  });

  test("send failure is surfaced (send_failed) with the cause, never swallowed", async () => {
    const d = deps({
      send: async () => {
        throw new Error("tmux send-keys failed");
      },
    });
    const result = await executeAction("compact", "/Users/x/wt/issue-441", d);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("send_failed");
    expect(result.detail).toContain("tmux send-keys failed");
  });

  test("non-allowlisted action is structurally refused and never sends", async () => {
    const d = deps();
    const result = await executeAction("rm-rf", "/Users/x/wt/issue-441", d);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("disallowed_action");
    expect(d.sent).toHaveLength(0);
  });
});

describe("action/execute resolveTmuxSessionForTarget", () => {
  // Identity realpath by default; a normalising variant is used to prove the
  // comparison is realpath-based rather than raw-string.
  const identity = (p: string) => p;

  function resolveDeps(overrides: Partial<SessionResolveDeps> = {}): SessionResolveDeps {
    return {
      runningSessions: () => [],
      listTmuxPanes: async () => [],
      realpath: identity,
      ...overrides,
    };
  }

  test("prefers the DB session and does not walk tmux when it matches", async () => {
    let walked = false;
    const session = await resolveTmuxSessionForTarget("/wt/a", resolveDeps({
      runningSessions: () => [
        { tmuxSession: "claude-db111111", projectDir: "/wt/a" },
        { tmuxSession: "claude-db222222", projectDir: "/wt/b" },
      ],
      listTmuxPanes: async () => {
        walked = true;
        return [];
      },
    }));
    expect(session).toBe("claude-db111111");
    expect(walked).toBe(false);
  });

  test("falls back to the tmux pane cwd walk when the DB misses", async () => {
    const session = await resolveTmuxSessionForTarget("/wt/c", resolveDeps({
      runningSessions: () => [{ tmuxSession: "claude-db111111", projectDir: "/wt/a" }],
      listTmuxPanes: async () => [
        { sessionName: "claude-pane00000", cwd: "/wt/b" },
        { sessionName: "manual-shell", cwd: "/wt/c" },
      ],
    }));
    expect(session).toBe("manual-shell");
  });

  test("returns null when neither source matches", async () => {
    const session = await resolveTmuxSessionForTarget("/wt/none", resolveDeps({
      runningSessions: () => [{ tmuxSession: "claude-db111111", projectDir: "/wt/a" }],
      listTmuxPanes: async () => [{ sessionName: "s", cwd: "/wt/b" }],
    }));
    expect(session).toBeNull();
  });

  test("a tmux walk failure resolves to null (not an exception)", async () => {
    const session = await resolveTmuxSessionForTarget("/wt/x", resolveDeps({
      runningSessions: () => [],
      listTmuxPanes: async () => {
        throw new Error("no server running");
      },
    }));
    expect(session).toBeNull();
  });

  test("comparison is realpath-normalised (trailing slash still matches)", async () => {
    const stripTrailingSlash = (p: string) => p.replace(/\/+$/, "");
    const session = await resolveTmuxSessionForTarget("/wt/a/", resolveDeps({
      runningSessions: () => [{ tmuxSession: "claude-norm00000", projectDir: "/wt/a" }],
      realpath: stripTrailingSlash,
    }));
    expect(session).toBe("claude-norm00000");
  });
});

describe("action/execute realpathOrResolve", () => {
  test("falls back to resolve for a non-existent path (no throw)", () => {
    const p = "/definitely/not/here/xyz-12345";
    expect(realpathOrResolve(p)).toBe(p);
  });
});

describe("action/execute realWritePermDecision", () => {
  test("writes only when <id>.pending exists, and only once", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { realWritePermDecision } = await import("../../src/action/execute");
    const dir = mkdtempSync(join(tmpdir(), "perm-"));
    const prev = process.env.PERM_REQUEST_DIR;
    process.env.PERM_REQUEST_DIR = dir;
    try {
      expect(await realWritePermDecision("req-nopending", "allow")).toBe(false);
      expect(existsSync(join(dir, "req-nopending.decision"))).toBe(false);

      writeFileSync(join(dir, "req-12345678.pending"), "");
      expect(await realWritePermDecision("req-12345678", "allow")).toBe(true);
      expect(readFileSync(join(dir, "req-12345678.decision"), "utf8")).toBe("allow");
      await expect(realWritePermDecision("req-12345678", "deny")).rejects.toThrow();
      expect(readFileSync(join(dir, "req-12345678.decision"), "utf8")).toBe("allow");
    } finally {
      if (prev === undefined) delete process.env.PERM_REQUEST_DIR;
      else process.env.PERM_REQUEST_DIR = prev;
    }
  });
});
