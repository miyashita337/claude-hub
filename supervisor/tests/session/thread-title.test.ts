import { test, expect, describe } from "bun:test";
import {
  buildThreadTitle,
  sanitizeBranchForTitle,
  markTitleStopped,
} from "../../src/session/thread-title";

/**
 * Issue #175: session thread titles switch from "chat name + increment" to a
 * branch-based scheme `{emoji} {branch} · {displayName}` with a same-branch
 * sequence suffix. These pin the pure helper against the agreed component AC.
 */
describe("buildThreadTitle (Issue #175)", () => {
  test("AC-1: single same-branch session omits the sequence suffix", () => {
    expect(buildThreadTitle("running", "feat/x", "Team Salary", 1)).toBe(
      "🟢 feat/x · Team Salary"
    );
  });

  test("AC-2: a 2nd same-branch session appends (2)", () => {
    expect(buildThreadTitle("running", "feat/x", "Team Salary", 2)).toBe(
      "🟢 feat/x · Team Salary (2)"
    );
  });

  test("resume uses the ♻️ emoji with the same branch scheme", () => {
    expect(buildThreadTitle("resume", "feat/x", "Team Salary", 1)).toBe(
      "♻️ feat/x · Team Salary"
    );
  });

  test("AC-3: an over-long branch is centre-truncated to keep the title ≤ 100", () => {
    const longBranch = "feat/" + "a".repeat(200) + "/end";
    const title = buildThreadTitle("running", longBranch, "Team Salary", 1);
    expect(title.length).toBeLessThanOrEqual(100);
    // The display name and separator survive truncation (only the branch is cut).
    expect(title.endsWith(" · Team Salary")).toBe(true);
    // Centre truncation keeps both ends of the branch around an ellipsis.
    expect(title).toContain("…");
    expect(title.startsWith("🟢 feat/")).toBe(true);
  });

  test("a pathologically long display name falls back to display-name-only (no dangling ' · ')", () => {
    const longName = "X".repeat(120);
    const title = buildThreadTitle("running", "feat/x", longName, 1);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).not.toContain(" · ");
    expect(title).not.toContain("  "); // no double space
    expect(title.startsWith("🟢 X")).toBe(true);
  });

  test("AC-5: a null branch falls back to the display-name-only legacy title", () => {
    expect(buildThreadTitle("running", null, "Team Salary", 1)).toBe(
      "🟢 Team Salary"
    );
    expect(buildThreadTitle("resume", undefined, "Team Salary", 1)).toBe(
      "♻️ Team Salary"
    );
    expect(buildThreadTitle("running", "", "Team Salary", 2)).toBe(
      "🟢 Team Salary (2)"
    );
  });
});

describe("sanitizeBranchForTitle (Issue #175 AC-4)", () => {
  test("strips RTL override (U+202E) used for display spoofing", () => {
    expect(sanitizeBranchForTitle("feat‮evil")).toBe("featevil");
  });

  test("strips zero-width characters", () => {
    expect(sanitizeBranchForTitle("feat​x﻿y")).toBe("featxy");
  });

  test("strips newlines and control characters", () => {
    expect(sanitizeBranchForTitle("feat\nx\ty\r")).toBe("featxy");
  });

  test("keeps ordinary spaces (display-safe; git rejects them in refs anyway)", () => {
    expect(sanitizeBranchForTitle("a b")).toBe("a b");
  });

  test("strips bidi isolates", () => {
    expect(sanitizeBranchForTitle("a⁦b⁩c")).toBe("abc");
  });

  test("leaves ordinary branch names (including slashes) untouched", () => {
    expect(sanitizeBranchForTitle("feat/167-session-id")).toBe(
      "feat/167-session-id"
    );
  });

  test("AC-4: a sanitised branch cannot reintroduce a control char via the title", () => {
    const title = buildThreadTitle(
      "running",
      "feat‮/evil\n",
      "Team Salary",
      1
    );
    // No control / bidi chars survive in the rendered title.
    for (const ch of title) {
      const code = ch.codePointAt(0)!;
      const isBidiOrControl =
        code <= 0x1f || // space (0x20) is already excluded by <= 0x1f
        code === 0x7f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      expect(isBidiOrControl).toBe(false);
    }
  });
});

describe("markTitleStopped (Issue #175 AC-6)", () => {
  test("running 🟢 → 🔴", () => {
    expect(markTitleStopped("🟢 feat/x · Team Salary")).toBe(
      "🔴 feat/x · Team Salary"
    );
  });

  test("resume ♻️ → 🔴 (fixes the reaper.ts:56 bug that skipped ♻️)", () => {
    expect(markTitleStopped("♻️ feat/x · Team Salary")).toBe(
      "🔴 feat/x · Team Salary"
    );
  });

  test("an already-stopped title is left unchanged", () => {
    expect(markTitleStopped("🔴 feat/x · Team Salary")).toBe(
      "🔴 feat/x · Team Salary"
    );
  });
});
