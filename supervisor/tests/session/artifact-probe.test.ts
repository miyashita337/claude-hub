import { test, expect, describe } from "bun:test";
import {
  probeArtifacts,
  artifactWindowStart,
  describeArtifacts,
  type ArtifactCmdRunner,
  type ArtifactProbeInput,
} from "../../src/session/artifact-probe";

/**
 * Issue #342 Layer 2 extension — zero-artifact detection contract. All runs
 * use a scripted fake runner: no real git/gh is spawned, so the decision
 * logic (cheap-first short-circuit / fail-loud unknown / dirty carry) is
 * asserted deterministically.
 */

const START = new Date("2026-08-06T03:00:00.123Z");

function input(overrides: Partial<ArtifactProbeInput> = {}): ArtifactProbeInput {
  return {
    cwd: "/tmp/wt",
    branch: "corp-dispatch-42",
    issueNumber: 42,
    startedAt: START,
    ...overrides,
  };
}

/**
 * Script the runner by command signature. Keys:
 *   status  → `git status --porcelain`
 *   log     → `git log …`
 *   pr      → `gh pr list …`
 *   issues  → `gh issue list …`
 *   comments→ `gh api …/comments…`
 * Unscripted keys resolve to ok+empty. `calls` records the order for
 * short-circuit assertions.
 */
function fakeRunner(
  script: Partial<Record<string, { ok: true; stdout: string } | { ok: false; error: string }>>,
  calls: string[] = [],
): ArtifactCmdRunner {
  return async (cmd, args) => {
    const key =
      cmd === "git" && args[0] === "status"
        ? "status"
        : cmd === "git" && args[0] === "log"
          ? "log"
          : cmd === "gh" && args[0] === "pr"
            ? "pr"
            : cmd === "gh" && args[0] === "issue"
              ? "issues"
              : cmd === "gh" && args[0] === "api"
                ? "comments"
                : `${cmd} ${args[0]}`;
    calls.push(key);
    return script[key] ?? { ok: true, stdout: "" };
  };
}

describe("artifactWindowStart", () => {
  test("strips fractional seconds (GitHub search rejects them)", () => {
    expect(artifactWindowStart(START)).toBe("2026-08-06T03:00:00Z");
  });
});

describe("probeArtifacts", () => {
  test("commit hit short-circuits before any gh call (offline-capable)", async () => {
    const calls: string[] = [];
    const res = await probeArtifacts(
      input(),
      fakeRunner(
        {
          log: { ok: true, stdout: "0123456789abcdef0123456789abcdef01234567\n" },
        },
        calls,
      ),
    );
    expect(res.status).toBe("found");
    expect(res.detail).toBe("commit 01234567");
    expect(calls).toEqual(["status", "log"]);
  });

  test("PR on the head branch counts as an artifact", async () => {
    const res = await probeArtifacts(
      input(),
      fakeRunner({ pr: { ok: true, stdout: '[{"number":12}]' } }),
    );
    expect(res.status).toBe("found");
    expect(res.detail).toBe("pr #12");
  });

  test("Issue created in the window counts, but the dispatch's own target Issue is excluded", async () => {
    const res = await probeArtifacts(
      input({ issueNumber: 42 }),
      fakeRunner({
        issues: { ok: true, stdout: '[{"number":42},{"number":99}]' },
      }),
    );
    expect(res.status).toBe("found");
    expect(res.detail).toBe("issue #99");
  });

  test("only the target Issue in the created window is NOT an artifact", async () => {
    const res = await probeArtifacts(
      input({ issueNumber: 42 }),
      fakeRunner({ issues: { ok: true, stdout: '[{"number":42}]' } }),
    );
    expect(res.status).toBe("none");
  });

  test("comments on the target Issue in the window count as an artifact", async () => {
    const calls: string[] = [];
    const res = await probeArtifacts(
      input(),
      fakeRunner({ comments: { ok: true, stdout: "3\n" } }, calls),
    );
    expect(res.status).toBe("found");
    expect(res.detail).toBe("comments 3件");
    // The comments endpoint carries the since-window and the issue number.
    expect(calls).toEqual(["status", "log", "pr", "issues", "comments"]);
  });

  test("no target Issue → comment check is skipped entirely", async () => {
    const calls: string[] = [];
    const res = await probeArtifacts(
      input({ issueNumber: null }),
      fakeRunner({}, calls),
    );
    expect(res.status).toBe("none");
    expect(calls).not.toContain("comments");
  });

  test("all checks empty → none, with dirty carried from git status", async () => {
    const res = await probeArtifacts(
      input(),
      fakeRunner({ status: { ok: true, stdout: " M src/foo.ts\n" } }),
    );
    expect(res.status).toBe("none");
    expect(res.dirty).toBe(true);
    expect(describeArtifacts(res)).toContain("未 commit の変更");
  });

  test("a failing gh check with nothing found is fail-loud unknown, never none", async () => {
    const res = await probeArtifacts(
      input(),
      fakeRunner({ pr: { ok: false, error: "gh: connection refused" } }),
    );
    expect(res.status).toBe("unknown");
    expect(res.detail).toContain("gh pr list");
    expect(describeArtifacts(res)).toContain("検証不能");
  });

  test("a commit hit still wins when gh is down (local git needs no network)", async () => {
    const res = await probeArtifacts(
      input(),
      fakeRunner({
        log: { ok: true, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" },
        pr: { ok: false, error: "network down" },
      }),
    );
    expect(res.status).toBe("found");
  });

  test("unparsable gh JSON is a no-hit, not an artifact", async () => {
    const res = await probeArtifacts(
      input(),
      fakeRunner({
        pr: { ok: true, stdout: "not json" },
        issues: { ok: true, stdout: '{"oops":true}' },
      }),
    );
    expect(res.status).toBe("none");
  });

  test("since-window and issue number are threaded into the gh arguments", async () => {
    const seen: string[][] = [];
    await probeArtifacts(input(), async (cmd, args) => {
      seen.push([cmd, ...args]);
      return { ok: true, stdout: "" };
    });
    const flat = seen.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("--since=2026-08-06T03:00:00Z"))).toBe(true);
    expect(flat.some((c) => c.includes("created:>=2026-08-06T03:00:00Z"))).toBe(true);
    expect(
      flat.some((c) =>
        c.includes("issues/42/comments?since=2026-08-06T03:00:00Z"),
      ),
    ).toBe(true);
  });
});
