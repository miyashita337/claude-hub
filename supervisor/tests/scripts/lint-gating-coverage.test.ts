import { test, expect, describe } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";
import {
  analyzeCoverage,
  extractGatedFiles,
  hasFailure,
  EXCLUSIONS,
  type Exclusion,
} from "../../scripts/lint-gating-coverage";

/**
 * Issue #248: the gating-coverage lint must (AC-1) fail when a test file is
 * neither gated in ci.yml nor excluded, (AC-2) pass when every existing test
 * file is gated or excluded, and (AC-3) fail when an exclusion entry has no
 * reason. The final "real repo" test makes AC-2 a live regression guard against
 * future gate omissions.
 *
 * Issue #385 widened the scanned scope from `tests/` to `tests/` + `src/`. The
 * cases below pin that widening: colocated `src/**\/*.test.ts` files must be
 * recognised as gated when passed to `bun test`, and the real-repo scan must
 * include them so the six previously-invisible suites cannot silently drop out
 * of CI again.
 */

describe("extractGatedFiles", () => {
  test("collects every tests/*.test.ts passed to a bun test step", () => {
    const yaml = `      - name: Run tests
        run: |
          bun test --coverage \\
                   tests/session/relay.test.ts \\
                   tests/infra/db.test.ts
      - name: Isolated
        run: bun test tests/session/adapters-hassession.test.ts`;
    const gated = extractGatedFiles(yaml);
    expect(gated.has("tests/session/relay.test.ts")).toBe(true);
    expect(gated.has("tests/infra/db.test.ts")).toBe(true);
    expect(gated.has("tests/session/adapters-hassession.test.ts")).toBe(true);
    expect(gated.size).toBe(3);
  });

  test("collects colocated src/*.test.ts passed to a bun test step (#385)", () => {
    const yaml = `      - name: Run tests
        run: |
          bun test --coverage \\
                   tests/session/relay.test.ts \\
                   src/session/iterm2.test.ts \\
                   src/session/goal-watcher.test.ts`;
    const gated = extractGatedFiles(yaml);
    expect(gated.has("src/session/iterm2.test.ts")).toBe(true);
    expect(gated.has("src/session/goal-watcher.test.ts")).toBe(true);
    expect(gated.size).toBe(3);
  });

  test("ignores a test file mentioned only in a comment (not a real run arg)", () => {
    // A "local-only" note must NOT be read as gating — for either tree.
    const yaml = `      # Local-only: tests/session/iterm2-async.test.ts is a wall-clock flake
      # and src/session/iterm2.test.ts is merely referenced here
      - name: Run tests
        run: bun test tests/session/relay.test.ts`;
    const gated = extractGatedFiles(yaml);
    expect(gated.has("tests/session/relay.test.ts")).toBe(true);
    expect(gated.has("tests/session/iterm2-async.test.ts")).toBe(false);
    expect(gated.has("src/session/iterm2.test.ts")).toBe(false);
  });
});

describe("analyzeCoverage", () => {
  const exclusions: Exclusion[] = [
    { file: "tests/session/iterm2-async.test.ts", reason: "wall-clock flake" },
  ];

  test("AC-1: a file neither gated nor excluded is reported as ungated", () => {
    const r = analyzeCoverage({
      testFiles: ["tests/session/new-feature.test.ts", "tests/session/relay.test.ts"],
      gated: new Set(["tests/session/relay.test.ts"]),
      exclusions,
    });
    expect(r.ungated).toEqual(["tests/session/new-feature.test.ts"]);
    expect(hasFailure(r)).toBe(true);
  });

  test("AC-2: every file gated or excluded → no violation", () => {
    const r = analyzeCoverage({
      testFiles: [
        "tests/session/relay.test.ts",
        "tests/session/iterm2-async.test.ts",
      ],
      gated: new Set(["tests/session/relay.test.ts"]),
      exclusions,
    });
    expect(r.ungated).toEqual([]);
    expect(hasFailure(r)).toBe(false);
  });

  test("#385: an ungated colocated src test is reported, not silently passed", () => {
    // The exact hole #385 closed: before the scope widening this file was never
    // even scanned, so it could not appear in `ungated` at all.
    const r = analyzeCoverage({
      testFiles: ["src/session/iterm2.test.ts", "tests/session/relay.test.ts"],
      gated: new Set(["tests/session/relay.test.ts"]),
      exclusions,
    });
    expect(r.ungated).toEqual(["src/session/iterm2.test.ts"]);
    expect(hasFailure(r)).toBe(true);
  });

  test("AC-3: an exclusion with a blank reason fails", () => {
    const r = analyzeCoverage({
      testFiles: ["tests/session/x.test.ts"],
      gated: new Set<string>(),
      exclusions: [{ file: "tests/session/x.test.ts", reason: "   " }],
    });
    expect(r.emptyReason).toEqual(["tests/session/x.test.ts"]);
    expect(hasFailure(r)).toBe(true);
  });

  test("a stale exclusion (missing file) fails", () => {
    const r = analyzeCoverage({
      testFiles: [],
      gated: new Set<string>(),
      exclusions: [{ file: "tests/session/deleted.test.ts", reason: "gone" }],
      fileExists: () => false,
    });
    expect(r.staleExclusions).toEqual(["tests/session/deleted.test.ts"]);
    expect(hasFailure(r)).toBe(true);
  });

  test("an exclusion that is also gated is flagged redundant (warning, not failure)", () => {
    const r = analyzeCoverage({
      testFiles: ["tests/session/relay.test.ts"],
      gated: new Set(["tests/session/relay.test.ts"]),
      exclusions: [{ file: "tests/session/relay.test.ts", reason: "was excluded once" }],
    });
    expect(r.redundant).toEqual(["tests/session/relay.test.ts"]);
    expect(hasFailure(r)).toBe(false);
  });
});

describe("real repository (AC-2 regression guard)", () => {
  test("every tests/ and src/ *.test.ts is gated in ci.yml or justifiably excluded", async () => {
    const root = resolve(import.meta.dir, "../.."); // supervisor/
    const ciYaml = await Bun.file(resolve(root, "../.github/workflows/ci.yml")).text();
    const gated = extractGatedFiles(ciYaml);

    const { Glob } = await import("bun");
    // Must mirror the script's own scan (#385) — if this only globbed tests/,
    // a colocated src suite could rot out of CI with this guard still green.
    const testFiles = [
      ...new Glob("tests/**/*.test.ts").scanSync(root),
      ...new Glob("src/**/*.test.ts").scanSync(root),
    ].sort();
    expect(testFiles.length).toBeGreaterThan(0);

    const report = analyzeCoverage({
      testFiles,
      gated,
      exclusions: EXCLUSIONS,
      fileExists: (f) => existsSync(resolve(root, f)),
    });

    // Surface the offending files in the assertion message, not just a count.
    expect({
      ungated: report.ungated,
      emptyReason: report.emptyReason,
      staleExclusions: report.staleExclusions,
    }).toEqual({ ungated: [], emptyReason: [], staleExclusions: [] });
  });

  test("#385: the colocated src suites are actually gated, not merely scanned", async () => {
    // Pins the outcome, not just the mechanism: these six files were silently
    // never run in CI before #385. If one is dropped from ci.yml this fails
    // even if someone also removes it from the glob above.
    const root = resolve(import.meta.dir, "../..");
    const ciYaml = await Bun.file(resolve(root, "../.github/workflows/ci.yml")).text();
    const gated = extractGatedFiles(ciYaml);

    const { Glob } = await import("bun");
    const colocated = [...new Glob("src/**/*.test.ts").scanSync(root)].sort();
    expect(colocated.length).toBeGreaterThan(0);

    const excluded = new Set(EXCLUSIONS.map((e) => e.file));
    expect(colocated.filter((f) => !gated.has(f) && !excluded.has(f))).toEqual([]);
  });

  test("this lint's own test file is gated (no self-exemption)", async () => {
    const root = resolve(import.meta.dir, "../..");
    const ciYaml = await Bun.file(resolve(root, "../.github/workflows/ci.yml")).text();
    const gated = extractGatedFiles(ciYaml);
    expect(gated.has("tests/scripts/lint-gating-coverage.test.ts")).toBe(true);
  });
});
