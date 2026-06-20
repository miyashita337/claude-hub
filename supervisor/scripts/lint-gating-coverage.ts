#!/usr/bin/env bun
/**
 * Issue #248 (RW-029 / F1 class): CI gating-coverage lint.
 *
 * ci.yml runs the Unit/E2E suites from an explicit WHITELIST of files passed to
 * `bun test` (deterministic on purpose — it avoids Bun's process-global
 * `mock.module` pollution leaking between files). The weakness of a whitelist:
 * a newly-added test file under `tests/` that nobody remembers to add is
 * SILENTLY never run in CI. That is exactly how #238's regression test slipped
 * (PR #247 — the F1 that motivated this issue) and how the shell-exec-safety
 * security guard (#159 / RW-045) sits red-but-ungated today. Same failure class
 * as RW-029: a silently-green CI is worse than a red one.
 *
 * This lint scans every test file under `tests/` and requires each to be either:
 *   1. gated   — passed as an argument to some `bun test` step in ci.yml, or
 *   2. excluded — listed in EXCLUSIONS below WITH a non-empty reason.
 * Any other test file fails the build (a new gate omission). To stop the
 * exclusion list from rotting into a silent dumping ground, an entry with an
 * empty reason, or one that points at a file that no longer exists, also fails.
 *
 * Run: `bun scripts/lint-gating-coverage.ts` (from supervisor/). Exits 1 on any
 * violation. Scope is intentionally the `tests/` tree only — colocated tests
 * living under `src/` are out of scope for this issue (tracked separately).
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/** A test file intentionally NOT gated in ci.yml. Each MUST carry a real reason. */
export interface Exclusion {
  file: string;
  reason: string;
}

/**
 * Files deliberately excluded from CI gating. Adding an entry is a conscious
 * decision that must be justified here — "I forgot to gate it" is not a reason,
 * such files belong in ci.yml instead.
 */
export const EXCLUSIONS: Exclusion[] = [
  {
    file: "tests/session/iterm2.test.ts",
    reason:
      "local-only: needs ~/.claude/scripts/project-colors.json (macOS iTerm2 tab colours), absent on CI ubuntu — see ci.yml 'Local-only tests' note.",
  },
  {
    file: "tests/session/iterm2-async.test.ts",
    reason:
      "macOS-only timing: markTabStopped shells out to real `osascript`, which blocks >100ms on a Mac and fails the non-blocking assertion. Not deterministic across runners.",
  },
  {
    file: "tests/guards/shell-exec-safety.test.ts",
    reason:
      "RED on main: src/infra/db.ts:45 ALTER TABLE interpolation lacks a `// shell-safe:` justification (#159 / RW-045 guard). Gating is blocked until the justification is added — tracked in #253.",
  },
];

/**
 * Pull every `tests/...*.test.ts` token out of the *command* lines of ci.yml.
 *
 * Comment lines (YAML `#`) are dropped first so that a file merely *mentioned*
 * in a comment (e.g. the "Local-only tests" note) is never mistaken for gated —
 * only paths inside an actual `run:` shell body count.
 */
export function extractGatedFiles(ciYaml: string): Set<string> {
  const gated = new Set<string>();
  for (const rawLine of ciYaml.split("\n")) {
    if (rawLine.trimStart().startsWith("#")) continue; // skip comments
    for (const m of rawLine.matchAll(/tests\/[A-Za-z0-9_./-]+\.test\.ts/g)) {
      gated.add(m[0]);
    }
  }
  return gated;
}

export interface CoverageReport {
  /** In tests/ but neither gated nor excluded — a silent gate omission. */
  ungated: string[];
  /** Exclusion entries with a blank reason (silent exclusion). */
  emptyReason: string[];
  /** Exclusion entries whose file no longer exists (rotted list). */
  staleExclusions: string[];
  /** Excluded AND gated — the exclusion is now redundant (warning only). */
  redundant: string[];
}

export function analyzeCoverage(args: {
  testFiles: string[];
  gated: Set<string>;
  exclusions: Exclusion[];
  /** Existence probe (injectable for tests); defaults to "always exists". */
  fileExists?: (file: string) => boolean;
}): CoverageReport {
  const { testFiles, gated, exclusions } = args;
  const exists = args.fileExists ?? (() => true);
  const excludedSet = new Set(exclusions.map((e) => e.file));

  return {
    ungated: testFiles
      .filter((f) => !gated.has(f) && !excludedSet.has(f))
      .sort(),
    emptyReason: exclusions
      .filter((e) => e.reason.trim() === "")
      .map((e) => e.file),
    staleExclusions: exclusions.filter((e) => !exists(e.file)).map((e) => e.file),
    redundant: exclusions.filter((e) => gated.has(e.file)).map((e) => e.file),
  };
}

/** True when the report contains a build-failing violation (redundant is warn-only). */
export function hasFailure(r: CoverageReport): boolean {
  return (
    r.ungated.length > 0 ||
    r.emptyReason.length > 0 ||
    r.staleExclusions.length > 0
  );
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, ".."); // supervisor/
  const ciPath = resolve(root, "../.github/workflows/ci.yml");

  const ciYaml = readFileSync(ciPath, "utf8");
  const gated = extractGatedFiles(ciYaml);

  const { Glob } = await import("bun");
  const testFiles = [...new Glob("tests/**/*.test.ts").scanSync(root)].sort();
  if (testFiles.length === 0) {
    console.error(
      `✖ lint-gating-coverage: no test files found under ${root}/tests — refusing to report clean.`,
    );
    process.exit(1);
  }

  const report = analyzeCoverage({
    testFiles,
    gated,
    exclusions: EXCLUSIONS,
    fileExists: (f) => existsSync(resolve(root, f)),
  });

  for (const f of report.redundant) {
    console.error(
      `⚠ ${f}: in EXCLUSIONS but also gated in ci.yml — drop the exclusion entry.`,
    );
  }

  if (!hasFailure(report)) {
    console.log(
      `✓ lint-gating-coverage: ${testFiles.length} test file(s) — ${gated.size} gated, ${EXCLUSIONS.length} excluded, 0 ungated.`,
    );
    process.exit(0);
  }

  for (const f of report.ungated) {
    console.error(
      `${f}: not gated in ci.yml and not in EXCLUSIONS — add it to a 'bun test' step or justify it in scripts/lint-gating-coverage.ts.`,
    );
  }
  for (const f of report.emptyReason) {
    console.error(`${f}: EXCLUSIONS entry has an empty reason — state why it is not gated.`);
  }
  for (const f of report.staleExclusions) {
    console.error(`${f}: EXCLUSIONS entry points at a missing file — remove the stale entry.`);
  }

  console.error(
    `\n✖ gating-coverage violation(s) (Issue #248).\n` +
      `  A test that is neither gated in ci.yml nor justifiably excluded is never run in CI —\n` +
      `  it can rot to red without anyone noticing (RW-029: a silently-green CI is worse than a red one).`,
  );
  process.exit(1);
}
