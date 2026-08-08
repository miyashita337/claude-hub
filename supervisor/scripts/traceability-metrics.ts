#!/usr/bin/env bun
/**
 * Issue #384 (Epic #381): traceability weekly metrics.
 *
 * The #381 analysis quantified why bugs recur: main's fix-commit ratio was 29%
 * (42/145), only 13% of PRs were caught by CI pre-merge, and just 55% of bug
 * issues carried an evidence-backed `## 再現手順`. Those were one-off manual
 * numbers — this script recomputes the observable subset on a schedule so the
 * Epic's improvements (regression gates, real-env E2E) show up as trend lines
 * instead of anecdotes.
 *
 * Metrics (window = --days, default 90):
 *   1. fix-commit ratio on main   (git log --first-parent origin/main)
 *   2. revert count on main       (same source)
 *   3. CI failures on main pushes (gh api actions/runs — merge escapes that
 *      turned main red)
 *   4. repro-section rate on bug-type issues (gh issue list)
 *
 * Read-only: only `git log` and read-scoped `gh` calls. No Pushover, no writes.
 * Run: `bun scripts/traceability-metrics.ts --days 90` (from supervisor/).
 * The weekly GitHub Actions workflow pipes the output into the Step Summary
 * (consumer, per rules/general/observability.md) — see
 * .github/workflows/traceability-metrics.yml.
 */

export interface CommitStats {
  total: number;
  fix: number;
  revert: number;
}

/**
 * Classify git subject lines. `fix` counts conventional-commit fix prefixes
 * only (`fix:` / `fix(scope):` / `fix(#370):`), not arbitrary words starting
 * with "fix" — the ratio must not drift when someone adds a `fixture:` type.
 */
export function parseGitSubjects(subjects: string[]): CommitStats {
  let fix = 0;
  let revert = 0;
  for (const s of subjects) {
    if (/^fix[:(]/.test(s)) fix++;
    // `git revert` writes `Revert "..."`; count manual `revert:` too.
    if (/^revert[:( "]/i.test(s)) revert++;
  }
  return { total: subjects.length, fix, revert };
}

export interface CiRunLite {
  head_branch: string | null;
  event: string;
  conclusion: string | null;
}

export interface CiStats {
  mainRuns: number;
  mainFailures: number;
}

/**
 * Merge-escape signal: completed CI runs triggered by a push to main. A
 * failure here means a bug got past the PR gate and turned main red.
 * PR-branch runs, manual dispatches, and still-running runs are excluded.
 */
export function summarizeCiRuns(runs: CiRunLite[]): CiStats {
  const mainPush = runs.filter(
    (r) => r.head_branch === "main" && r.event === "push" && r.conclusion !== null,
  );
  return {
    mainRuns: mainPush.length,
    mainFailures: mainPush.filter((r) => r.conclusion === "failure").length,
  };
}

export interface IssueLite {
  number: number;
  title: string;
  labels: { name: string }[];
  body: string | null;
}

export interface IssueStats {
  bugTotal: number;
  bugWithRepro: number;
}

/**
 * Bug-type proxy: labelled bug/P0, or a title carrying a defect keyword. This
 * is intentionally a stable heuristic (same one used for the #381 baseline),
 * not a perfect classifier — the trend matters, so the rule must stay fixed.
 */
const BUG_TITLE = /(bug|fix\b|不具合|エラー|壊れ|落ち|直らない|crash|stall|silent)/i;

export function analyzeIssues(issues: IssueLite[]): IssueStats {
  const bugs = issues.filter(
    (i) =>
      i.labels.some((l) => l.name === "bug" || l.name === "P0") || BUG_TITLE.test(i.title),
  );
  return {
    bugTotal: bugs.length,
    bugWithRepro: bugs.filter((i) => (i.body ?? "").includes("## 再現手順")).length,
  };
}

export interface ReportInput {
  days: number;
  commits: CommitStats;
  ci: CiStats;
  issues: IssueStats;
  generatedAt: string;
}

function pct(num: number, den: number): string {
  if (den === 0) return "n/a";
  return `${((num / den) * 100).toFixed(1)}%`;
}

export function renderReport(r: ReportInput): string {
  const { commits, ci, issues } = r;
  return [
    `## トレーサビリティ週次メトリクス（直近 ${r.days} 日, ${r.generatedAt}）`,
    "",
    "| 指標 | 実測 | 比率 |",
    "|---|---|---|",
    `| main の fix コミット比率 | ${commits.fix}/${commits.total} | ${pct(commits.fix, commits.total)} |`,
    `| main の revert コミット数 | ${commits.revert} | — |`,
    `| main push CI の failure（merge エスケープ） | ${ci.mainFailures}/${ci.mainRuns} | ${pct(ci.mainFailures, ci.mainRuns)} |`,
    `| バグ型 Issue の \`## 再現手順\` 保有率 | ${issues.bugWithRepro}/${issues.bugTotal} | ${pct(issues.bugWithRepro, issues.bugTotal)} |`,
    "",
    // The #381 manual analysis (fix 42/145=29.0%) walked *all* commits reachable
    // through merge commits; this script uses --first-parent (one entry per
    // landing on main), so its numbers are lower. Trends must only be compared
    // against this script's own history, anchored to the first scripted run:
    "ベースライン（2026-08-08 初回スクリプト実測, 90日窓）: fix 22/94=23.4% / main 赤 4/92 / 再現手順 21/40=52.5%（#381 手動解析の 42/145 とは分母定義が異なる）",
  ].join("\n");
}

if (import.meta.main) {
  const { $ } = await import("bun");
  const daysArg = process.argv.indexOf("--days");
  const days = daysArg !== -1 ? Number(process.argv[daysArg + 1]) : 90;
  if (!Number.isInteger(days) || days <= 0) {
    console.error(`✖ --days must be a positive integer, got: ${process.argv[daysArg + 1]}`);
    process.exit(1);
  }

  const repo =
    process.env.GH_REPO ??
    (await $`gh repo view --json nameWithOwner -q .nameWithOwner`.text()).trim();

  // Prefer origin/main (fresh after fetch); fall back to local main.
  const ref =
    (await $`git rev-parse --verify -q origin/main`.nothrow().quiet()).exitCode === 0
      ? "origin/main"
      : "main";
  const logText = await $`git log --first-parent --since=${days + " days ago"} --pretty=%s ${ref}`.text();
  const subjects = logText.split("\n").filter((l) => l.trim() !== "");

  const sinceDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  // Server-side `created` filter keeps the window exact; pages are followed
  // until exhausted (cap 20 = 2000 runs, far above the weekly cadence — if the
  // cap ever clips, say so instead of silently under-reporting failures).
  const runs: CiRunLite[] = [];
  for (let page = 1; page <= 20; page++) {
    const chunk = JSON.parse(
      await $`gh api ${"repos/" + repo + "/actions/runs?per_page=100&page=" + page + "&created=>=" + sinceDate}`.text(),
    ).workflow_runs as CiRunLite[];
    runs.push(...chunk);
    if (chunk.length < 100) break;
    if (page === 20) console.error(`⚠ CI run pagination capped at 2000 within ${days}d — mainRuns may undercount.`);
  }

  // Same window as the commit metric. Closed bugs stay in the denominator on
  // purpose: a fixed-and-closed bug still either had repro steps or didn't.
  const issues: IssueLite[] = JSON.parse(
    await $`gh issue list -R ${repo} --state all --limit 500 --search ${"created:>=" + sinceDate} --json number,title,labels,body`.text(),
  );

  const report = renderReport({
    days,
    commits: parseGitSubjects(subjects),
    ci: summarizeCiRuns(runs),
    issues: analyzeIssues(issues),
    generatedAt: new Date().toISOString(),
  });
  console.log(report);
}
