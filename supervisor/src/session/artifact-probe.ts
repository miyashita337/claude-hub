/**
 * Post-exit artifact probe for headless dispatch runs (Issue #342, Layer 2
 * extension).
 *
 * #368 closed the "pending work left behind" hole: a run that leaves
 * background tasks / a ScheduleWakeup reservation is flagged `pending`. This
 * module closes the remaining one: a run that leaves NO pending signal but
 * also produced NOTHING — no commit, no PR, no Issue, no comment — and exits 0
 * would still be treated as a success. Both holes are the same disease
 * ("exit 0 must not masquerade as delivery"); this probe checks the delivery
 * side.
 *
 * Artifact definition (会長レビュー 2026-08-06): investigation dispatches
 * (/inv etc.) legitimately produce no commits — their deliverable is an Issue
 * or an Issue comment. So "artifact" is ANY of:
 *
 *   1. a commit on the dispatch branch dated after the run started,
 *   2. a PR whose head is the dispatch branch,
 *   3. an Issue created in the target repo after the run started,
 *   4. a comment posted to the target Issue after the run started.
 *
 * One hit is enough (checked cheap-first, short-circuiting). All four empty →
 * `none`. A check that errors while nothing was found → `unknown` (fail-LOUD,
 * same principle as the completion probe: "could not verify" must never be
 * folded into "verified OK").
 *
 * Known accepted limitations (documented, not bugs):
 *   - The Issue-created check is time-window based; a concurrent session
 *     creating an Issue in the same repo within the window counts as a hit.
 *     All dispatches run as the same gh account, so an author filter would not
 *     tighten this.
 *   - A pre-existing PR on a re-dispatched branch counts as a hit: the branch
 *     has a delivery vehicle, which is what "zero artifacts" must exclude.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Bound each git/gh probe call so a wedged gh can never hang teardown. */
const PROBE_CMD_TIMEOUT_MS = 15_000;

export type ArtifactStatus = "found" | "none" | "unknown";

export interface ArtifactProbe {
  status: ArtifactStatus;
  /**
   * Evidence: the first artifact found (`commit <sha>` / `pr #N` /
   * `issue #N` / `comments <n>件`), probe errors when `unknown`, "" when
   * `none`.
   */
  detail: string;
  /**
   * True when the worktree has uncommitted changes. Not an artifact (nothing
   * was delivered) but recovery-worthy: a `none`+dirty worktree is retained
   * instead of removed, so abandoned edits survive (the #456 failure lost its
   * work precisely because the worktree was reclaimed).
   */
  dirty: boolean;
}

export interface ArtifactProbeInput {
  /** Branch worktree cwd — git state and gh repo resolution both come from here. */
  cwd: string;
  /** Dispatch branch (the PR head to look for). */
  branch: string;
  /** Target Issue number, or null when the dispatch had none (no comment check then). */
  issueNumber: number | null;
  /** Run start — lower bound of the artifact window. */
  startedAt: Date;
}

/**
 * Command runner seam. Production shells out via async execFile (same
 * non-blocking discipline as the issueReporter adapter); tests inject a fake
 * so no real git/gh runs.
 */
export type ArtifactCmdRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

const realRunner: ArtifactCmdRunner = async (cmd, args, cwd) => {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: PROBE_CMD_TIMEOUT_MS,
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * GitHub search accepts full ISO-8601 timestamps (`created:>=…THH:MM:SSZ`)
 * but not fractional seconds — strip the milliseconds the JS Date carries.
 */
export function artifactWindowStart(startedAt: Date): string {
  return startedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Run the artifact checks, cheap-first with short-circuit:
 * local git (commit / dirty) → PR → Issues created → Issue comments. The two
 * git checks work offline, so a gh outage cannot mask a run that did commit.
 */
export async function probeArtifacts(
  input: ArtifactProbeInput,
  run: ArtifactCmdRunner = realRunner,
): Promise<ArtifactProbe> {
  const since = artifactWindowStart(input.startedAt);
  const errors: string[] = [];

  // Dirty state first: it feeds the retention decision regardless of which
  // artifact check short-circuits. An error here degrades to "not dirty" but
  // is carried into the unknown-detail if nothing is found.
  let dirty = false;
  const status = await run("git", ["status", "--porcelain"], input.cwd);
  if (status.ok) {
    dirty = status.stdout.trim().length > 0;
  } else {
    errors.push(`git status: ${status.error}`);
  }

  // 1. Commit on the branch inside the run window (offline-capable).
  const commit = await run(
    "git",
    ["log", "-1", `--since=${since}`, "--format=%H"],
    input.cwd,
  );
  if (commit.ok) {
    const sha = commit.stdout.trim();
    if (sha) {
      return { status: "found", detail: `commit ${sha.slice(0, 8)}`, dirty };
    }
  } else {
    errors.push(`git log: ${commit.error}`);
  }

  // 2. PR with this branch as head (any state — a delivery vehicle exists).
  const pr = await run(
    "gh",
    [
      "pr",
      "list",
      "--head",
      input.branch,
      "--state",
      "all",
      "--json",
      "number",
      "--limit",
      "1",
    ],
    input.cwd,
  );
  if (pr.ok) {
    const num = firstNumber(pr.stdout);
    if (num !== null) {
      return { status: "found", detail: `pr #${num}`, dirty };
    }
  } else {
    errors.push(`gh pr list: ${pr.error}`);
  }

  // 3. Issue / Epic created in the target repo inside the run window.
  const issues = await run(
    "gh",
    [
      "issue",
      "list",
      "--search",
      `created:>=${since}`,
      "--json",
      "number",
      "--limit",
      "10",
    ],
    input.cwd,
  );
  if (issues.ok) {
    const num = firstNumber(issues.stdout, input.issueNumber);
    if (num !== null) {
      return { status: "found", detail: `issue #${num}`, dirty };
    }
  } else {
    errors.push(`gh issue list: ${issues.error}`);
  }

  // 4. Comment on the target Issue inside the run window. Runs BEFORE the
  //    dispatch report is posted, so the report itself never counts.
  if (input.issueNumber !== null) {
    const comments = await run(
      "gh",
      [
        "api",
        `repos/{owner}/{repo}/issues/${input.issueNumber}/comments?since=${since}&per_page=100`,
        "--jq",
        "length",
      ],
      input.cwd,
    );
    if (comments.ok) {
      const n = Number.parseInt(comments.stdout.trim(), 10);
      if (Number.isFinite(n) && n > 0) {
        return { status: "found", detail: `comments ${n}件`, dirty };
      }
    } else {
      errors.push(`gh api comments: ${comments.error}`);
    }
  }

  if (errors.length > 0) {
    // Nothing found AND at least one check could not run: fail-loud.
    return { status: "unknown", detail: errors.join(" / "), dirty };
  }
  return { status: "none", detail: "", dirty };
}

/**
 * Parse a gh `--json number` payload and return the first number, skipping
 * `exclude` (the dispatch's own target Issue predates the run but would match
 * a `created:>=` window race). Returns null on empty / unparsable output —
 * an unparsable success is treated as "no hit", never as an artifact.
 */
function firstNumber(jsonText: string, exclude: number | null = null): number | null {
  try {
    const arr = JSON.parse(jsonText) as Array<{ number?: unknown }>;
    if (!Array.isArray(arr)) return null;
    for (const row of arr) {
      if (typeof row.number === "number" && row.number !== exclude) {
        return row.number;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** One-line human summary for report / thread-warning use. "" when found-clean. */
export function describeArtifacts(probe: ArtifactProbe): string {
  if (probe.status === "found") return probe.detail;
  if (probe.status === "unknown") return `検証不能 (${probe.detail})`;
  return probe.dirty
    ? "成果物なし（未 commit の変更が worktree に残存）"
    : "成果物なし";
}
