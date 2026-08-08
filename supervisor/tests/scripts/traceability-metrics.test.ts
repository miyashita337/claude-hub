/**
 * Issue #384 (Epic #381): traceability weekly metrics.
 *
 * The #381 analysis produced one-off numbers (main fix ratio 29%, pre-merge CI
 * catch rate 13%, repro-section rate 55%). These tests pin the pure aggregation
 * logic so the recurring report keeps producing the same numbers for the same
 * inputs — the metric itself must not silently drift (that would defeat a
 * traceability metric).
 */
import { describe, expect, test } from "bun:test";

import {
  analyzeIssues,
  parseGitSubjects,
  renderReport,
  summarizeCiRuns,
  type IssueLite,
} from "../../scripts/traceability-metrics";

describe("parseGitSubjects", () => {
  test("counts fix (both `fix:` and `fix(scope):`), revert, and total", () => {
    const subjects = [
      "fix: supervisor shutdown の worktree 破壊を修正 (#378)",
      "fix(#370): AskUserQuestion を Discord に中継 (#373)",
      "feat: headless dispatch に成果物ゼロ検知を追加 (#371)",
      'Revert "feat: broken thing"',
      "chore: bump deps",
      "docs: update bot-operations",
    ];
    expect(parseGitSubjects(subjects)).toEqual({
      total: 6,
      fix: 2,
      revert: 1,
    });
  });

  test("does not count fixture/prefix look-alikes as fix", () => {
    const subjects = ["fixture: add test data", "prefix: something", "refactor: fix-adjacent rename"];
    expect(parseGitSubjects(subjects).fix).toBe(0);
  });

  test("empty input yields zeros", () => {
    expect(parseGitSubjects([])).toEqual({ total: 0, fix: 0, revert: 0 });
  });
});

describe("summarizeCiRuns", () => {
  const run = (over: Partial<Parameters<typeof summarizeCiRuns>[0][number]>) => ({
    head_branch: "main",
    event: "push",
    conclusion: "success" as string | null,
    ...over,
  });

  test("counts only completed main-push runs; failures separately", () => {
    const runs = [
      run({}),
      run({ conclusion: "failure" }),
      run({ head_branch: "feat/x", event: "pull_request", conclusion: "failure" }), // PR branch: excluded
      run({ conclusion: null }), // still running: excluded
      run({ event: "workflow_dispatch" }), // manual: excluded
    ];
    expect(summarizeCiRuns(runs)).toEqual({ mainRuns: 2, mainFailures: 1 });
  });
});

describe("analyzeIssues", () => {
  const issue = (over: Partial<IssueLite>): IssueLite => ({
    number: 1,
    title: "feat: something",
    labels: [],
    body: "",
    ...over,
  });

  test("classifies bug by label (bug / P0) and by title keyword", () => {
    const issues = [
      issue({ number: 1, labels: [{ name: "bug" }] }),
      issue({ number: 2, labels: [{ name: "P0" }] }),
      issue({ number: 3, title: "○○が壊れている" }),
      issue({ number: 4, title: "fix: relay が落ちる" }),
      issue({ number: 5, title: "feat: 新機能", labels: [{ name: "enhancement" }] }),
    ];
    const r = analyzeIssues(issues);
    expect(r.bugTotal).toBe(4);
  });

  test("counts repro sections only among bug-type issues", () => {
    const issues = [
      issue({ number: 1, labels: [{ name: "bug" }], body: "## 再現手順\n\n```bash\nbun test\n```" }),
      issue({ number: 2, labels: [{ name: "bug" }], body: "なんか動かない" }),
      // non-bug with a repro section must not inflate the numerator
      issue({ number: 3, title: "feat: x", body: "## 再現手順\nn/a" }),
    ];
    const r = analyzeIssues(issues);
    expect(r.bugTotal).toBe(2);
    expect(r.bugWithRepro).toBe(1);
  });

  test("empty issue list yields zeros (no NaN ratios downstream)", () => {
    const r = analyzeIssues([]);
    expect(r.bugTotal).toBe(0);
    expect(r.bugWithRepro).toBe(0);
  });
});

describe("renderReport", () => {
  test("renders all four metric rows with computed ratios", () => {
    const md = renderReport({
      days: 90,
      commits: { total: 145, fix: 42, revert: 0 },
      ci: { mainRuns: 158, mainFailures: 7 },
      issues: { bugTotal: 40, bugWithRepro: 22 },
      generatedAt: "2026-08-08T12:00:00Z",
    });
    expect(md).toContain("fix コミット比率");
    expect(md).toContain("42/145");
    expect(md).toContain("29.0%");
    expect(md).toContain("revert");
    expect(md).toContain("7/158");
    expect(md).toContain("再現手順");
    expect(md).toContain("22/40");
    expect(md).toContain("55.0%");
    expect(md).toContain("90"); // window
  });

  test("zero denominators render as n/a, not NaN", () => {
    const md = renderReport({
      days: 7,
      commits: { total: 0, fix: 0, revert: 0 },
      ci: { mainRuns: 0, mainFailures: 0 },
      issues: { bugTotal: 0, bugWithRepro: 0 },
      generatedAt: "2026-08-08T12:00:00Z",
    });
    expect(md).not.toContain("NaN");
    expect(md).toContain("n/a");
  });
});
