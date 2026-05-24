import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { resolve, sep } from "path";

/**
 * Per-branch git worktree management for supervisor sessions (Issue #154).
 *
 * `/session start <branch>` runs claude in a dedicated worktree under
 * `<mainRepoDir>/.claude/worktrees/<branch>` instead of sharing the project's
 * main worktree. This isolates a session's untracked files / stash from other
 * work on the same repo. Worktrees are created on start and removed on the
 * explicit `/session stop`; the branch itself is preserved (Discord brainstorm
 * 2026-05-24, Q3).
 *
 * Design decisions (issue body):
 *   Q1 existing branch  → `git worktree add <path> <branch>` (checkout)
 *   Q2 unknown branch   → base = repo default branch, `git worktree add -b
 *                          <branch> --no-track <path> <base>`
 *   Q4 existing worktree → reuse as-is (idempotent, multi-session continue)
 *
 * Low-level git/gh calls go through {@link GitGhRunner} so the branching logic
 * in {@link ensureWorktree} is unit-testable with an in-memory fake (no real
 * git/gh). The real runner uses `execFileSync` with an argv array — never a
 * shell string — so a branch name can never inject shell metacharacters
 * (Q6 "git に任せる": validation is delegated to git, but the filesystem path
 * is additionally guarded against traversal and shell-injection below).
 */

/** Subdirectory (relative to the main repo) that holds per-branch worktrees. */
export const WORKTREE_SUBDIR = ".claude/worktrees";

export interface GitGhRunner {
  /** True if `branch` is an existing *local branch* in the repo at `mainRepoDir`. */
  branchExists(mainRepoDir: string, branch: string): boolean;
  /** Repo default branch (Q2 base for new branches). Falls back to "main". */
  defaultBranch(mainRepoDir: string): string;
  /** `git worktree add <worktreePath> <branch>` (existing branch, Q1). */
  addWorktreeFromBranch(
    mainRepoDir: string,
    worktreePath: string,
    branch: string,
  ): void;
  /** `git worktree add -b <branch> --no-track <worktreePath> <base>` (Q2). */
  addWorktreeNewBranch(
    mainRepoDir: string,
    worktreePath: string,
    branch: string,
    base: string,
  ): void;
  /** `git worktree remove <worktreePath> --force` (Q3). */
  removeWorktree(mainRepoDir: string, worktreePath: string): void;
  /** Filesystem existence check for the worktree path (Q4 reuse). */
  pathExists(path: string): boolean;
}

export interface EnsureWorktreeResult {
  /** Absolute path of the worktree (claude cwd). */
  path: string;
  /** True when an existing worktree was reused (Q4) rather than created. */
  reused: boolean;
  /** Base branch used when a new branch was created (Q2); undefined otherwise. */
  baseBranch?: string;
}

/**
 * Reject branch names that are unsafe to embed in the downstream shell command.
 *
 * The worktree path is later interpolated into a double-quoted shell string
 * (`cd "<path>"` in manager.ts, executed by tmux via `sh -c`). A branch
 * containing `"`, `` ` ``, `$` or `\` would break out of the double quotes and
 * allow command injection; a control character (e.g. a newline) would break
 * the `&&` command chain. git forbids most of these in ref names, but the path
 * is computed before git runs, so this is a necessary security boundary — not
 * the general "let git validate" of Q6.
 */
function assertShellSafeBranch(branch: string): void {
  for (let i = 0; i < branch.length; i++) {
    const code = branch.charCodeAt(i);
    const ch = branch[i];
    if (code < 0x20 || ch === '"' || ch === "`" || ch === "$" || ch === "\\") {
      throw new Error(`branch 名に使用できない文字が含まれています: ${branch}`);
    }
  }
}

/**
 * Compute the worktree path for a branch and reject path traversal / unsafe
 * names. `<mainRepoDir>/.claude/worktrees/<branch>`. Branch names containing
 * `/` (e.g. `feat/foo`) map to nested directories, which is fine. A name that
 * resolves outside the worktrees root (e.g. `../../etc`) is rejected.
 */
export function resolveWorktreePath(mainRepoDir: string, branch: string): string {
  assertShellSafeBranch(branch);
  const root = resolve(mainRepoDir, WORKTREE_SUBDIR);
  const path = resolve(root, branch);
  if (path === root) {
    throw new Error(`branch 名が不正です（空または '.'）: ${branch}`);
  }
  if (!path.startsWith(root + sep)) {
    throw new Error(`branch 名が不正です（path traversal）: ${branch}`);
  }
  return path;
}

/**
 * Ensure a worktree exists for `branch`, creating it if necessary. Idempotent:
 * an already-present worktree is reused (Q4), so calling this twice for the
 * same branch is safe.
 */
export function ensureWorktree(
  mainRepoDir: string,
  branch: string,
  runner: GitGhRunner,
): EnsureWorktreeResult {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw new Error("branch 引数が必須です");
  }
  const worktreePath = resolveWorktreePath(mainRepoDir, trimmed);

  // Q4: existing worktree → reuse.
  if (runner.pathExists(worktreePath)) {
    return { path: worktreePath, reused: true };
  }

  // Q1: existing local branch → checkout into a new worktree.
  if (runner.branchExists(mainRepoDir, trimmed)) {
    runner.addWorktreeFromBranch(mainRepoDir, worktreePath, trimmed);
    return { path: worktreePath, reused: false };
  }

  // Q2: unknown branch → create from the repo's default branch.
  const base = runner.defaultBranch(mainRepoDir);
  runner.addWorktreeNewBranch(mainRepoDir, worktreePath, trimmed, base);
  return { path: worktreePath, reused: false, baseBranch: base };
}

/** Remove a worktree (Q3). Caller decides whether failures are fatal. */
export function removeWorktree(
  mainRepoDir: string,
  worktreePath: string,
  runner: GitGhRunner,
): void {
  runner.removeWorktree(mainRepoDir, worktreePath);
}

/**
 * Production {@link GitGhRunner}. Every git/gh invocation uses execFileSync
 * with an argv array (no shell) so untrusted branch names are passed as a
 * single literal argument and cannot inject shell metacharacters.
 */
export const realGitGhRunner: GitGhRunner = {
  branchExists(mainRepoDir, branch) {
    try {
      // Restrict to local *branch* refs so revision expressions like `HEAD~1`
      // or `@{-1}` are not mistaken for an existing branch (which would create
      // a detached-HEAD worktree). exit 0 iff refs/heads/<branch> resolves.
      execFileSync(
        "git",
        [
          "-C",
          mainRepoDir,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  },
  defaultBranch(mainRepoDir) {
    // Primary: GitHub default branch (issue Q2). `:owner/:repo` is resolved by
    // gh from the repo at cwd.
    try {
      const out = execFileSync(
        "gh",
        ["api", "repos/:owner/:repo", "--jq", ".default_branch"],
        { cwd: mainRepoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .trim();
      if (out) return out;
    } catch {
      // gh unavailable, not authenticated, or repo has no GitHub remote.
    }
    // Fallback: local origin/HEAD if configured.
    try {
      const ref = execFileSync(
        "git",
        ["-C", mainRepoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .trim();
      const prefix = "origin/";
      if (ref.startsWith(prefix)) return ref.slice(prefix.length);
    } catch {
      // No origin/HEAD configured.
    }
    return "main";
  },
  addWorktreeFromBranch(mainRepoDir, worktreePath, branch) {
    // stderr is piped so a failure surfaces git's message in the thrown error.
    execFileSync(
      "git",
      ["-C", mainRepoDir, "worktree", "add", worktreePath, branch],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  },
  addWorktreeNewBranch(mainRepoDir, worktreePath, branch, base) {
    execFileSync(
      "git",
      [
        "-C",
        mainRepoDir,
        "worktree",
        "add",
        "-b",
        branch,
        "--no-track",
        worktreePath,
        base,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  },
  removeWorktree(mainRepoDir, worktreePath) {
    execFileSync(
      "git",
      ["-C", mainRepoDir, "worktree", "remove", worktreePath, "--force"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  },
  pathExists(path) {
    return existsSync(path);
  },
};
