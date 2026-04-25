import { describe, test, expect } from "bun:test";
import {
  looksLikeSlashCommand,
  stripLeadingSlash,
} from "../../src/session/slash-prefix";

/**
 * Tests for Issue #86: typo'd slash commands like `/hanle-review` from a
 * Discord message previously hung Claude Code's Ink TUI in its slash-command
 * picker, blocking the per-thread relay queue until RELAY_TIMEOUT_MS.
 */

describe("looksLikeSlashCommand", () => {
  test.each([
    ["/handle-reviews", true],
    ["/handle-reviews 109", true],
    ["/hanle-review XXX", true],
    ["/sesssion-resume", true],
    ["/help", true],
    ["/help me", true],
    ["/h", true], // single letter command
    ["/abc_under-score123", true],
  ])("matches `%s` → %s (slash-command shape)", (input, expected) => {
    expect(looksLikeSlashCommand(input)).toBe(expected);
  });

  test.each([
    ["/usr/bin/ls", false], // path: first token followed by `/`, not space
    ["/Users/x/foo", false], // path
    ["/", false], // bare slash, no letter
    ["//comment", false], // not letter after first `/`
    ["/123abc", false], // starts with digit
    ["", false], // empty
    ["普通のテキスト", false], // no slash
    ["何か /handle-reviews", false], // not at start
    ["/-leading-dash", false], // not letter immediately after slash
  ])("rejects `%s` → %s", (input, expected) => {
    expect(looksLikeSlashCommand(input)).toBe(expected);
  });
});

describe("stripLeadingSlash", () => {
  test("strips a slash-command prefix (the typo case)", () => {
    expect(stripLeadingSlash("/hanle-review XXX")).toBe("hanle-review XXX");
  });

  test("strips a slash-command prefix with no args", () => {
    expect(stripLeadingSlash("/handle-reviews")).toBe("handle-reviews");
  });

  test("preserves a path-like leading slash (`/usr/bin/ls`)", () => {
    expect(stripLeadingSlash("/usr/bin/ls")).toBe("/usr/bin/ls");
  });

  test("preserves a path-like leading slash (`/Users/x/foo`)", () => {
    expect(stripLeadingSlash("/Users/x/foo")).toBe("/Users/x/foo");
  });

  test("preserves arbitrary natural language", () => {
    expect(stripLeadingSlash("普通のテキスト")).toBe("普通のテキスト");
  });

  test("preserves a slash that is not at the very start", () => {
    expect(stripLeadingSlash("何か /handle-reviews")).toBe(
      "何か /handle-reviews"
    );
  });

  test("preserves bare slash (no letter follows)", () => {
    expect(stripLeadingSlash("/")).toBe("/");
  });

  test("preserves empty string", () => {
    expect(stripLeadingSlash("")).toBe("");
  });

  test("only strips a single leading slash, not deeper structure", () => {
    // The narrow regex ensures we don't strip into a path
    expect(stripLeadingSlash("/handle-reviews and /foo")).toBe(
      "handle-reviews and /foo",
    );
  });
});
