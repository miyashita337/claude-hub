import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveColor, dimColor, isItermRunning } from "../../src/session/iterm2";

/**
 * Issue #385: this file used to be local-only — `resolveColor`'s lookup-table
 * cases asserted colours that only exist in the developer's real
 * `~/.claude/scripts/project-colors.json`, so on CI (which has no such file)
 * they fell through to the hash fallback and failed. It was therefore excluded
 * from CI gating and the whole lookup path — including the "longest prefix
 * wins" rule — went unguarded.
 *
 * It is now hermetic: the suite writes its OWN fixture to a temp dir and points
 * `SUPERVISOR_PROJECT_COLORS_PATH` at it (see `projectColorsPath()`), so the
 * expected colours are defined here rather than inherited from the machine.
 * Verified by running with a throwaway `$HOME`: 0 failures.
 */

const FIXTURE_COLORS = {
  projects: {
    team_salary: "#1e1028",
    team_salary_blog: "#102525",
  },
  default_saturation: 0.3,
  default_brightness: 0.12,
};

let fixtureDir: string;
let previousOverride: string | undefined;

beforeAll(() => {
  previousOverride = process.env.SUPERVISOR_PROJECT_COLORS_PATH;
  fixtureDir = mkdtempSync(join(tmpdir(), "iterm2-colors-"));
  const fixturePath = join(fixtureDir, "project-colors.json");
  writeFileSync(fixturePath, JSON.stringify(FIXTURE_COLORS), "utf8");
  process.env.SUPERVISOR_PROJECT_COLORS_PATH = fixturePath;
});

afterAll(() => {
  if (previousOverride === undefined) {
    delete process.env.SUPERVISOR_PROJECT_COLORS_PATH;
  } else {
    process.env.SUPERVISOR_PROJECT_COLORS_PATH = previousOverride;
  }
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("resolveColor", () => {
  test("returns exact match from project-colors.json", () => {
    const color = resolveColor("team_salary");
    expect(color).toBe("#1e1028");
  });

  test("returns prefix match (longest wins)", () => {
    // Both "team_salary" and "team_salary_blog" are prefixes of the input; the
    // longer key must win. This rule was previously unguarded in CI (#385).
    const color = resolveColor("team_salary_blog");
    expect(color).toBe("#102525");
  });

  test("returns hash-based color for unknown project", () => {
    const color = resolveColor("unknown-project-xyz");
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("hash-based color is deterministic", () => {
    const color1 = resolveColor("some-project");
    const color2 = resolveColor("some-project");
    expect(color1).toBe(color2);
  });

  test("falls back to a hash color when the config file is missing", () => {
    // The CI/no-config path: loadProjectColors swallows the read error and
    // returns empty defaults, so every project resolves via the hash. Guards
    // that a missing config degrades instead of throwing.
    const missing = join(fixtureDir, "does-not-exist.json");
    const restore = process.env.SUPERVISOR_PROJECT_COLORS_PATH;
    process.env.SUPERVISOR_PROJECT_COLORS_PATH = missing;
    try {
      expect(resolveColor("team_salary")).toMatch(/^#[0-9a-f]{6}$/);
      expect(resolveColor("team_salary")).not.toBe("#1e1028");
    } finally {
      process.env.SUPERVISOR_PROJECT_COLORS_PATH = restore;
    }
  });
});

describe("dimColor", () => {
  test("reduces brightness by 50%", () => {
    const dimmed = dimColor("#1e1028");
    expect(dimmed).toMatch(/^#[0-9a-f]{6}$/);
    const origR = parseInt("1e", 16);
    const dimR = parseInt(dimmed.slice(1, 3), 16);
    expect(dimR).toBeLessThanOrEqual(origR);
  });

  test("handles pure black", () => {
    const dimmed = dimColor("#000000");
    expect(dimmed).toBe("#000000");
  });

  test("handles bright color", () => {
    const dimmed = dimColor("#ff8844");
    expect(dimmed).toMatch(/^#[0-9a-f]{6}$/);
    const origR = parseInt("ff", 16);
    const dimR = parseInt(dimmed.slice(1, 3), 16);
    expect(dimR).toBeLessThan(origR);
  });
});

describe("isItermRunning", () => {
  // Issue #227 (PR-4): isItermRunning is async now (pgrep moved to the async
  // `execFile`), so it returns Promise<boolean> — await it before asserting.
  // Safe on CI: if `pgrep` is absent or matches nothing, execFile rejects and
  // the catch returns false, so the result is a boolean on every platform.
  test("resolves to a boolean", async () => {
    const result = await isItermRunning();
    expect(typeof result).toBe("boolean");
  });
});
