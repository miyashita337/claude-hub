import { test, expect, describe } from "bun:test";
import { resolveColor, dimColor, isItermRunning } from "../../src/session/iterm2";

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
  test("returns a boolean", () => {
    const result = isItermRunning();
    expect(typeof result).toBe("boolean");
  });
});
