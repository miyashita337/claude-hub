import { execFileSync } from "child_process";
import { existsSync, realpathSync } from "fs";
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

/**
 * Result of inspecting an on-disk path for Q4 reuse (Issue #158).
 *
 *   - `{ registered: false }`  the path exists but is NOT a path registered in
 *     `git worktree list` — i.e. residue from an interrupted `git worktree
 *     remove`, or a manually-created directory. Reusing it would run claude in
 *     a non-worktree dir (silent failure).
 *   - `{ registered: true, branch }`  the path is a registered worktree;
 *     `branch` is the checked-out local branch, or `null` for a detached HEAD.
 */
export type WorktreeStatus =
  | { registered: false }
  | { registered: true; branch: string | null };

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
  /**
   * Inspect whether `worktreePath` is a *registered* git worktree and, if so,
   * which branch it has checked out (Issue #158). Used to validate Q4 reuse
   * instead of trusting a bare directory existence check.
   */
  worktreeStatus(mainRepoDir: string, worktreePath: string): WorktreeStatus;
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

  // Q4: existing worktree → reuse, but only after validating it is a real
  // worktree on the expected branch (Issue #158). A bare existence check would
  // happily reuse an interrupted-`worktree remove` residue or a manually
  // created directory, running claude in a non-worktree / wrong-branch cwd —
  // a silent failure. Reject those explicitly instead.
  if (runner.pathExists(worktreePath)) {
    const status = runner.worktreeStatus(mainRepoDir, worktreePath);
    if (!status.registered) {
      throw new Error(
        `worktree 再利用先がディレクトリとして存在しますが有効な git worktree ではありません（中断した worktree remove の残骸 / 手動作成の可能性）: ${worktreePath}。手動で削除してから再実行してください。`,
      );
    }
    if (status.branch !== trimmed) {
      const actual = status.branch ?? "(detached HEAD)";
      throw new Error(
        `worktree 再利用先が期待 branch '${trimmed}' と一致しません（実際: '${actual}'）: ${worktreePath}。手動で確認・修正してから再実行してください。`,
      );
    }
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

/**
 * Re-create the worktree for an *existing* branch only — the resume-recovery
 * path (Issue #217). A branch session's worktree is physically removed on
 * `/session stop` (Q3, RW-046), but the branch and the conversation transcript
 * (keyed by cwd) survive. Rebuilding the worktree at the SAME path restores the
 * cwd that `claude --resume` needs.
 *
 * Unlike {@link ensureWorktree}, an unknown branch is intentionally NOT created
 * from the default branch (no Q2): resuming must never fabricate unrelated
 * content under the original branch's name. Returns true when the worktree
 * exists afterwards (Q4 already-present, or Q1 freshly checked out), false when
 * the branch is gone so the caller can surface a clear "cannot recover" error.
 */
export function recreateWorktreeForExistingBranch(
  mainRepoDir: string,
  branch: string,
  runner: GitGhRunner,
): boolean {
  const trimmed = branch.trim();
  if (!trimmed) {
    return false;
  }
  const worktreePath = resolveWorktreePath(mainRepoDir, trimmed);

  // Q4: a worktree is already present at the path → nothing to recover.
  if (runner.pathExists(worktreePath)) {
    return true;
  }

  // Q1: the branch still exists → check it out into a fresh worktree. A missing
  // branch falls through to `false` (no Q2 new-branch creation).
  if (runner.branchExists(mainRepoDir, trimmed)) {
    runner.addWorktreeFromBranch(mainRepoDir, worktreePath, trimmed);
    return true;
  }

  return false;
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
    // Fallback: the default branch of a configured remote's HEAD. Prefer
    // `origin`, but a fork / multi-remote checkout may name it differently
    // (e.g. `upstream`), so fall back to the first remote (PR #157 review,
    // gemini). The gh path above is already fork-safe; this only runs when gh
    // is unavailable.
    try {
      const remotes = execFileSync("git", ["-C", mainRepoDir, "remote"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (remote) {
        const ref = execFileSync(
          "git",
          ["-C", mainRepoDir, "symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        )
          .toString()
          .trim();
        const prefix = `${remote}/`;
        if (ref.startsWith(prefix)) return ref.slice(prefix.length);
      }
    } catch {
      // No remote / no <remote>/HEAD configured.
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
  worktreeStatus(mainRepoDir, worktreePath) {
    // Parse `git worktree list --porcelain`. Each worktree is a block of
    // newline-separated attribute lines, blocks separated by a blank line:
    //   worktree /abs/path
    //   HEAD <sha>
    //   branch refs/heads/<name>     (omitted / replaced by `detached`)
    // A path present on disk but absent from this listing is not a registered
    // worktree (Issue #158: residue / manual dir).
    let out: string;
    try {
      out = execFileSync(
        "git",
        ["-C", mainRepoDir, "worktree", "list", "--porcelain"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).toString();
    } catch {
      // Not a git repo / git unavailable → treat as unregistered (caller errors).
      return { registered: false };
    }

    const target = realpathOrResolve(worktreePath);
    for (const block of out.split(/\n\s*\n/)) {
      const lines = block.split("\n");
      const wtLine = lines.find((l) => l.startsWith("worktree "));
      if (!wtLine) continue;
      const wtPath = realpathOrResolve(wtLine.slice("worktree ".length).trim());
      if (wtPath !== target) continue;

      const branchLine = lines.find((l) => l.startsWith("branch "));
      if (branchLine) {
        const ref = branchLine.slice("branch ".length).trim();
        const branch = ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref;
        return { registered: true, branch };
      }
      // No `branch` line (`detached` present, or bare HEAD): no checked-out branch.
      return { registered: true, branch: null };
    }
    return { registered: false };
  },
};

/**
 * Normalize a path for comparison against `git worktree list` output, which
 * records canonical (symlink-resolved) absolute paths. Falls back to `resolve`
 * when the path cannot be realpath'd (e.g. it no longer exists).
 */
function realpathOrResolve(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}
