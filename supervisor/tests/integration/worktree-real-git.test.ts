import { test, expect, describe, afterAll, beforeEach, afterEach } from "bun:test";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ensureWorktree,
  realGitGhRunner,
  recreateWorktreeForExistingBranch,
  removeWorktree,
  resolveWorktreePath,
  type GitGhRunner,
} from "../../src/session/worktree";
import { SessionManager } from "../../src/session/manager";
import {
  createFakeEffects,
  type FakeSessionEffects,
} from "../../src/session/adapters-fake";
import { realWorktreeAdapter, type SessionEffects } from "../../src/session/adapters";
import type { ChannelConfig } from "../../src/config/channels";

/**
 * Issue #382 (Epic #381): worktree management verified against REAL git.
 *
 * Every pre-existing worktree test drives a fake {@link GitGhRunner}, so the
 * layer that actually destroyed uncommitted work — `git worktree add/remove/
 * list` and the on-disk state they produce — had never been executed by a test.
 * That gap lines up exactly with where the bugs kept coming back: #342 →
 * #368/#371/#372 → #369/#378. These tests close it by running the production
 * runner and the production {@link realWorktreeAdapter} against a throwaway git
 * repo in a temp dir, asserting on the real filesystem and on real
 * `git worktree list --porcelain` output.
 *
 * Scope (issue body): git is REAL, gh stays FAKE. The only gh call in the
 * production runner is `defaultBranch` (`gh api repos/:owner/:repo`); it is
 * stubbed in {@link gitRunner}, and the SessionManager cases use a pre-existing
 * branch so that path is never reached at all.
 *
 * Regressions pinned here:
 *   - #277        a new-branch worktree is cut from the FRESHLY FETCHED origin tip
 *   - #158        a residue dir / wrong-branch worktree is rejected, never reused
 *   - #369/#378   a supervisor shutdown preserves the worktree + uncommitted work
 *   - #378        a dead tmux session (hasSession false) does not tear it down
 *   - #342/#372   an `unknown` artifact probe retains the worktree
 *   - #217/#281   stop → resume re-creates the worktree at the same path
 */

const execFileAsync = promisify(execFile);

/**
 * Identity for the fixture's own commits, supplied as env instead of three
 * `git config` calls per repo (each git spawn costs ~100ms on macOS, and the
 * whole fixture has to fit inside bun's hook timeout). The production runner
 * never commits, so it does not need this.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Worktree Test",
  GIT_AUTHOR_EMAIL: "worktree-test@example.invalid",
  GIT_COMMITTER_NAME: "Worktree Test",
  GIT_COMMITTER_EMAIL: "worktree-test@example.invalid",
};

/** Run git in `cwd` and return trimmed stdout. Rejects (loudly) on failure. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", cwd, "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", env: GIT_ENV },
  );
  return stdout.trim();
}

/**
 * The production runner with ONLY its single gh call stubbed. `defaultBranch`
 * shells out to `gh api repos/:owner/:repo`, which needs a real GitHub remote
 * and an authenticated gh — neither exists for a temp repo, and the issue
 * explicitly keeps gh fake. Every other method is the real git one.
 */
const gitRunner: GitGhRunner = {
  ...realGitGhRunner,
  async defaultBranch() {
    return "main";
  },
};

/** Branch that exists in every fixture repo, carrying its own commit. */
const EXISTING_BRANCH = "feat-existing";
const EXISTING_BRANCH_FILE = "branch-content.txt";
const EXISTING_BRANCH_CONTENT = "committed on the branch\n";

interface WorktreeEntry {
  path: string;
  /** Checked-out branch, or null for a detached HEAD. */
  branch: string | null;
  /** git flagged the registration as stale (its directory is gone). */
  prunable: boolean;
}

/** Parse real `git worktree list --porcelain` output. */
async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const out = await git(repo, "worktree", "list", "--porcelain");
  const entries: WorktreeEntry[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const wtLine = lines.find((l) => l.startsWith("worktree "));
    if (!wtLine) continue;
    const branchLine = lines.find((l) => l.startsWith("branch "));
    entries.push({
      path: wtLine.slice("worktree ".length).trim(),
      branch: branchLine
        ? branchLine.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
        : null,
      prunable: lines.some((l) => l.startsWith("prunable")),
    });
  }
  return entries;
}

/** The registration for `path`, or undefined when git does not know it. */
async function worktreeEntry(
  repo: string,
  path: string,
): Promise<WorktreeEntry | undefined> {
  return (await listWorktrees(repo)).find((e) => e.path === path);
}

/** True when `branch` still resolves locally (Q3 preserves the branch). */
async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

// --- fixture -------------------------------------------------------------
//
// A real git repo per test, without paying for one per test: the template repo
// and its bare `origin` are built ONCE, and each test copies the template
// directory (~30ms) instead of re-running ~16 git commands (~2s on macOS).
//
// The template deliberately ships a STALE `refs/remotes/origin/main`: origin's
// main carries one commit the copy has never fetched. Only a real `git fetch`
// before `git worktree add` can land a new worktree on that tip, which is what
// makes the #277 assertion meaningful.

interface Template {
  /** Shared temp root: bare origin + template repo + per-test copies. */
  root: string;
  templateDir: string;
  /** Commit the template's local main points at (the stale base). */
  baseSha: string;
  /** Commit origin/main points at — reachable only after a fetch. */
  originTipSha: string;
}

async function buildTemplate(): Promise<Template> {
  // realpath because `git worktree list` prints canonical paths (on macOS
  // /var/folders → /private/var/folders) and the assertions compare those
  // against paths derived from repoDir.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-real-git-")));
  const originDir = join(root, "origin.git");
  const templateDir = join(root, "template");

  await execFileAsync("git", ["init", "-q", "--bare", originDir], { env: GIT_ENV });
  await execFileAsync("git", ["init", "-q", templateDir], { env: GIT_ENV });
  await git(templateDir, "symbolic-ref", "HEAD", "refs/heads/main");

  writeFileSync(join(templateDir, "README.md"), "base\n");
  await git(templateDir, "add", "README.md");
  await git(templateDir, "commit", "-qm", "base");
  await git(templateDir, "remote", "add", "origin", originDir);

  writeFileSync(join(templateDir, "advance.txt"), "merged elsewhere\n");
  await git(templateDir, "add", "advance.txt");
  await git(templateDir, "commit", "-qm", "advance");
  const [originTipSha, baseSha] = (
    await git(templateDir, "rev-parse", "HEAD", "HEAD~1")
  ).split("\n");

  await git(templateDir, "push", "-q", "-u", "origin", "main");

  // Rewind the local side only: main goes back to base and the remote-tracking
  // ref is pinned there too, so origin/main is stale until something fetches.
  await git(templateDir, "reset", "--hard", "-q", baseSha!);
  await git(templateDir, "update-ref", "refs/remotes/origin/main", baseSha!);

  // A branch that already exists in every copy (the Q1 / SessionManager path,
  // which never consults the gh-backed defaultBranch).
  await git(templateDir, "checkout", "-q", "-b", EXISTING_BRANCH);
  writeFileSync(join(templateDir, EXISTING_BRANCH_FILE), EXISTING_BRANCH_CONTENT);
  await git(templateDir, "add", EXISTING_BRANCH_FILE);
  await git(templateDir, "commit", "-qm", "branch commit");
  await git(templateDir, "checkout", "-q", "main");

  return { root, templateDir, baseSha: baseSha!, originTipSha: originTipSha! };
}

/**
 * Built at module scope, NOT in `beforeAll`: ~16 git spawns cost several
 * seconds on macOS, which exceeds bun:test's 5s hook timeout. Module evaluation
 * carries no such deadline, and the build still happens exactly once per file.
 */
const { root, templateDir, baseSha, originTipSha } = await buildTemplate();

/** Per-test: a fresh copy of the template, used as the "main repo dir". */
let repoDir: string;
let caseDir: string;
/** Managers created by a test, shut down in afterEach so no watcher leaks. */
let managers: SessionManager[];

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  repoDir = join(caseDir, "repo");
  cpSync(templateDir, repoDir, { recursive: true });
  managers = [];
});

afterEach(async () => {
  for (const m of managers) {
    await m.shutdownAll();
  }
  rmSync(caseDir, { recursive: true, force: true });
});

describe("#382 real git: ensureWorktree", () => {
  test("AC-1 / #277: an unknown branch is cut from the FRESHLY FETCHED origin tip", async () => {
    const result = await ensureWorktree(repoDir, "corp-dispatch-382", gitRunner);

    expect(result.reused).toBe(false);
    expect(result.baseBranch).toBe("origin/main");
    expect(existsSync(result.path)).toBe(true);

    // Real registration, not a fake's bookkeeping.
    const entry = await worktreeEntry(repoDir, result.path);
    expect(entry).toBeDefined();
    expect(entry!.branch).toBe("corp-dispatch-382");
    expect(entry!.prunable).toBe(false);

    // behind origin/main = 0: the fetch really ran before the add, so the
    // worktree sees work merged after this clone last fetched (#277).
    const head = await git(result.path, "rev-parse", "HEAD");
    expect(head).toBe(originTipSha);
    expect(head).not.toBe(baseSha);
    expect(existsSync(join(result.path, "advance.txt"))).toBe(true);
  });

  test("Q1: an existing branch is checked out with its own content", async () => {
    const result = await ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner);

    expect(result.reused).toBe(false);
    expect(result.baseBranch).toBeUndefined();
    expect(readFileSync(join(result.path, EXISTING_BRANCH_FILE), "utf8")).toBe(
      EXISTING_BRANCH_CONTENT,
    );
    // The primary worktree (on main) is untouched by the branch's commit.
    expect(existsSync(join(repoDir, EXISTING_BRANCH_FILE))).toBe(false);
    expect((await worktreeEntry(repoDir, result.path))?.branch).toBe(EXISTING_BRANCH);
  });

  test("Q4: a second ensure reuses the worktree without registering a duplicate", async () => {
    const first = await ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner);
    const before = await listWorktrees(repoDir);

    const second = await ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner);

    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);
    expect(await listWorktrees(repoDir)).toEqual(before);
  });

  test("#158: a plain directory at the path is rejected, not silently reused", async () => {
    const path = resolveWorktreePath(repoDir, "feat-residue");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "left-behind.txt"), "residue\n");

    await expect(ensureWorktree(repoDir, "feat-residue", gitRunner)).rejects.toThrow(
      /git worktree ではありません|残骸/,
    );
    // The rejection must not touch the directory or register anything.
    expect(readFileSync(join(path, "left-behind.txt"), "utf8")).toBe("residue\n");
    expect(await worktreeEntry(repoDir, path)).toBeUndefined();
  });

  test("#158: a real worktree checked out on a DIFFERENT branch is rejected", async () => {
    const path = resolveWorktreePath(repoDir, "feat-expected");
    // Genuinely register `path` on the wrong branch, via real git.
    await git(repoDir, "worktree", "add", "-q", path, EXISTING_BRANCH);

    await expect(ensureWorktree(repoDir, "feat-expected", gitRunner)).rejects.toThrow(
      /期待 branch/,
    );
    expect((await worktreeEntry(repoDir, path))?.branch).toBe(EXISTING_BRANCH);
  });

  test("a stale registration (directory deleted behind git's back) fails until prune clears it", async () => {
    // Real-git-only failure mode: once the directory is gone `pathExists` is
    // false, so ensureWorktree takes the Q1 add path — and git refuses, because
    // the path is "a missing but already registered worktree". A fake runner
    // cannot surface this at all, which is why #382 exists.
    const created = await ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner);
    rmSync(created.path, { recursive: true, force: true });

    expect((await worktreeEntry(repoDir, created.path))?.prunable).toBe(true);
    await expect(ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner)).rejects.toThrow();

    await git(repoDir, "worktree", "prune");

    const recreated = await ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner);
    expect(recreated.path).toBe(created.path);
    expect(existsSync(recreated.path)).toBe(true);
    const entry = await worktreeEntry(repoDir, created.path);
    expect(entry?.branch).toBe(EXISTING_BRANCH);
    expect(entry?.prunable).toBe(false);
  });
});

describe("#382 real git: removeWorktree (Q3) and resume recovery (#217/#281)", () => {
  test("Q3: remove deletes the directory and deregisters it, keeping the branch", async () => {
    const created = await ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner);

    await removeWorktree(repoDir, created.path, gitRunner);

    expect(existsSync(created.path)).toBe(false);
    expect(await worktreeEntry(repoDir, created.path)).toBeUndefined();
    // Q3's whole point: the branch survives, so the work stays recoverable.
    expect(await branchExists(repoDir, EXISTING_BRANCH)).toBe(true);
  });

  test("#217/#281: stop → resume re-creates the worktree at the SAME path with its content", async () => {
    const created = await ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner);
    await removeWorktree(repoDir, created.path, gitRunner);
    expect(existsSync(created.path)).toBe(false);

    const recovered = await recreateWorktreeForExistingBranch(
      repoDir,
      EXISTING_BRANCH,
      gitRunner,
    );

    expect(recovered).toBe(true);
    // Same cwd as before — that is what `claude --resume` (keyed by cwd) needs.
    expect(existsSync(created.path)).toBe(true);
    expect(readFileSync(join(created.path, EXISTING_BRANCH_FILE), "utf8")).toBe(
      EXISTING_BRANCH_CONTENT,
    );
    expect((await worktreeEntry(repoDir, created.path))?.branch).toBe(EXISTING_BRANCH);
  });

  test("#217: a deleted branch is NOT fabricated from default — returns false, creates nothing", async () => {
    const path = resolveWorktreePath(repoDir, "feat-gone");

    const recovered = await recreateWorktreeForExistingBranch(
      repoDir,
      "feat-gone",
      gitRunner,
    );

    expect(recovered).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(await worktreeEntry(repoDir, path)).toBeUndefined();
  });
});

/**
 * SessionManager teardown decisions, executed against the real worktree
 * adapter. tmux / iTerm2 / process signals / the executor stay faked — only the
 * worktree effect is real, so a wrong retention decision shows up as an actually
 * deleted directory instead of a missing entry in a fake's call log (note that
 * `removeWorktreeBestEffort` swallows removal errors, so a call log cannot even
 * prove removal happened).
 *
 * All cases use {@link EXISTING_BRANCH}, so ensureWorktree takes the Q1 path and
 * the gh-backed `defaultBranch` is never called.
 */
describe("#382 real git: SessionManager teardown", () => {
  let fake: FakeSessionEffects;

  function makeManager(opts: { watchIntervalMs?: number } = {}): SessionManager {
    fake = createFakeEffects();
    const effects: SessionEffects = { ...fake, worktree: realWorktreeAdapter };
    const manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      ...opts,
    });
    managers.push(manager);
    return manager;
  }

  function makeConfig(): ChannelConfig {
    return {
      channelName: "wt-real-git",
      dir: repoDir,
      displayName: "Worktree Real Git",
    };
  }

  /** Poll until `pred` holds, so a watcher tick is awaited without a fixed sleep. */
  async function waitUntil(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("waitUntil timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  test("AC-2 / #369: shutdownAll preserves the worktree AND its uncommitted changes", async () => {
    const manager = makeManager();
    const session = await manager.start(makeConfig(), "thread-shutdown", EXISTING_BRANCH);
    const wt = session.worktree!.path;
    // The exact loss shape of the handoff-96-2 incident: work that exists only
    // in the worktree when a SIGTERM / launchctl kickstart arrives.
    writeFileSync(join(wt, "WIP.txt"), "uncommitted work\n");

    await manager.shutdownAll();

    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(wt, "WIP.txt"), "utf8")).toBe("uncommitted work\n");
    // Still a live worktree, not an orphaned directory.
    expect(await git(wt, "status", "--porcelain")).toContain("WIP.txt");
    const entry = await worktreeEntry(repoDir, wt);
    expect(entry?.branch).toBe(EXISTING_BRANCH);
    expect(entry?.prunable).toBe(false);
  });

  test("#369: an explicit stop('supervisor_restart') preserves the worktree too", async () => {
    const manager = makeManager();
    const session = await manager.start(makeConfig(), "thread-sr", EXISTING_BRANCH);
    const wt = session.worktree!.path;
    writeFileSync(join(wt, "WIP.txt"), "uncommitted\n");

    await manager.stop("thread-sr", "supervisor_restart");

    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(wt, "WIP.txt"), "utf8")).toBe("uncommitted\n");
  });

  test("Q3 control: an explicit stop('manual') DOES remove the real worktree", async () => {
    // Without this the preservation cases above could pass vacuously (e.g. if
    // removal silently no-op'd against a real repo). Here removal must happen.
    const manager = makeManager();
    const session = await manager.start(makeConfig(), "thread-manual", EXISTING_BRANCH);
    const wt = session.worktree!.path;
    expect(existsSync(wt)).toBe(true);

    await manager.stop("thread-manual", "manual");

    expect(existsSync(wt)).toBe(false);
    expect(await worktreeEntry(repoDir, wt)).toBeUndefined();
    expect(await branchExists(repoDir, EXISTING_BRANCH)).toBe(true);
  });

  test("#378: a dead tmux session (hasSession false) must NOT tear the worktree down", async () => {
    const manager = makeManager({ watchIntervalMs: 5 });
    const session = await manager.start(makeConfig(), "thread-tmux-exit", EXISTING_BRANCH);
    const wt = session.worktree!.path;
    writeFileSync(join(wt, "WIP.txt"), "uncommitted\n");

    // hasSession now reports false — the #378 false-teardown trigger. The
    // session name comes from the sanctioned mapping, never re-derived here.
    await fake.tmux.killSession(
      SessionManager.tmuxSessionNameFor("thread-tmux-exit"),
    );
    await waitUntil(() => !manager.has("thread-tmux-exit"));

    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(wt, "WIP.txt"), "utf8")).toBe("uncommitted\n");
    expect((await worktreeEntry(repoDir, wt))?.branch).toBe(EXISTING_BRANCH);
  });
});

/**
 * Headless dispatch teardown (#342 / #371 / #372) against the real worktree.
 * The completion and artifact probes are injected (in production they shell out
 * to git/gh), the worktree effect is real — so "retained" / "reclaimed" is
 * asserted as an actual directory on disk.
 */
describe("#382 real git: headless dispatch retention (#342/#372)", () => {
  const cleanCompletion = () => ({
    ok: true as const,
    value: { pendingTasks: [], pendingWakeup: false, skippedLines: 0 },
  });

  function makeHeadlessManager(
    artifacts: () => Promise<{
      status: "found" | "none" | "unknown";
      detail: string;
      dirty: boolean;
    }>,
  ): SessionManager {
    const fake = createFakeEffects();
    const effects: SessionEffects = { ...fake, worktree: realWorktreeAdapter };
    const manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      probePendingWorkFn: cleanCompletion,
      probeArtifactsFn: artifacts,
    });
    managers.push(manager);
    return manager;
  }

  function makeConfig(): ChannelConfig {
    return {
      channelName: "wt-real-git-hl",
      dir: repoDir,
      displayName: "Worktree Real Git Headless",
    };
  }

  test("#372: an `unknown` artifact probe retains the real worktree and its edits", async () => {
    // Pre-create the worktree (runHeadless then reuses it, Q4) so abandoned
    // edits are already present when the run finishes — the agent-base#456
    // loss shape.
    const pre = await ensureWorktree(repoDir, EXISTING_BRANCH, gitRunner);
    writeFileSync(join(pre.path, "WIP.txt"), "abandoned edits\n");

    const manager = makeHeadlessManager(async () => ({
      status: "unknown" as const,
      detail: "gh pr list: connection refused",
      dirty: false,
    }));
    const res = await manager.runHeadless(
      makeConfig(),
      "thread-hl-unknown",
      "/impl 382",
      EXISTING_BRANCH,
    );

    expect(res.artifacts?.status).toBe("unknown");
    // "Could not verify" must never destroy possibly-live work (PR #371 review).
    expect(existsSync(pre.path)).toBe(true);
    expect(readFileSync(join(pre.path, "WIP.txt"), "utf8")).toBe("abandoned edits\n");
    expect(await worktreeEntry(repoDir, pre.path)).toBeDefined();
  });

  test("control: a clean run with a found artifact reclaims the real worktree", async () => {
    const manager = makeHeadlessManager(async () => ({
      status: "found" as const,
      detail: "pr #999",
      dirty: false,
    }));
    const res = await manager.runHeadless(
      makeConfig(),
      "thread-hl-found",
      "/impl 382",
      EXISTING_BRANCH,
    );

    expect(res.completion.status).toBe("clean");
    expect(res.artifacts?.status).toBe("found");
    const wt = resolveWorktreePath(repoDir, EXISTING_BRANCH);
    expect(existsSync(wt)).toBe(false);
    expect(await worktreeEntry(repoDir, wt)).toBeUndefined();
    expect(await branchExists(repoDir, EXISTING_BRANCH)).toBe(true);
  });
});
