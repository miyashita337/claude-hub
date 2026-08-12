import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Issue #417: the `in-progress` label must be removed automatically when an
 * issue closes.
 *
 * `commands/pdca.md` Step 4-6 leaves the label on at the end of a PDCA run and
 * delegates removal to `.github/workflows/issue-progress-cleanup.yml`. That
 * file never existed, so nothing removed it — and because `in-progress` is the
 * duplicate-work guard (Step 0-3 skips any issue that carries it), the stale
 * labels made the guard report work that nobody was doing.
 *
 * A workflow cannot be executed from a unit test, so this asserts the contract
 * the guard depends on: the trigger fires on every close path, the token can
 * actually write labels, and the step removes the right label. Those are the
 * parts that, if silently edited away, would put us back to a lying guard with
 * no other signal (RW-029: a silently-green CI is worse than a red one).
 */
const WORKFLOW_PATH = resolve(
  import.meta.dir,
  "../../../.github/workflows/issue-progress-cleanup.yml"
);

interface CleanupWorkflow {
  on?: { issues?: { types?: string[] } };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    { if?: string; steps?: { run?: string; env?: Record<string, string> }[] }
  >;
}

function loadWorkflow(): CleanupWorkflow {
  return Bun.YAML.parse(
    readFileSync(WORKFLOW_PATH, "utf8")
  ) as CleanupWorkflow;
}

describe("issue-progress-cleanup workflow (#417)", () => {
  test("the workflow file pdca.md delegates to actually exists", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  test("triggers on issue close, not on PR merge", () => {
    // Closing happens via `Closes #N` on a squash merge, `gh issue close`, and
    // the web UI. Keying on the close event covers all three; keying on merge
    // would miss the latter two.
    expect(loadWorkflow().on?.issues?.types).toEqual(["closed"]);
  });

  test("grants issues:write so the label removal is permitted", () => {
    // Without this the default read-only GITHUB_TOKEN makes the step fail —
    // and the label would silently stay on, which is the bug being fixed.
    expect(loadWorkflow().permissions?.issues).toBe("write");
  });

  test("removes the in-progress label", () => {
    const jobs = loadWorkflow().jobs ?? {};
    const runs = Object.values(jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "");

    expect(
      runs.some(
        (run) => run.includes("--remove-label") && run.includes("in-progress")
      )
    ).toBe(true);
  });

  test("only runs when the closed issue carries the label", () => {
    // Guard keeps the job a no-op for the vast majority of closes instead of
    // calling the API (and failing) for issues that never had the label.
    const jobs = Object.values(loadWorkflow().jobs ?? {});
    expect(jobs.length).toBeGreaterThan(0);
    expect(
      jobs.every((job) => (job.if ?? "").includes("in-progress"))
    ).toBe(true);
  });
});
