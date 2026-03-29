import { test, expect, describe } from "bun:test";
import { resolveColor } from "../../src/session/iterm2";

describe("resolveColor", () => {
  test("returns exact match from project-colors.json", () => {
    const color = resolveColor("team_salary");
    expect(color).toBe("#1e1028");
  });

  test("returns prefix match (longest wins)", () => {
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
});
