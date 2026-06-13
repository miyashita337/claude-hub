import { test, expect, describe } from "bun:test";
import {
  escapeAppleScriptString,
  buildOpenTabAppleScript,
  buildMarkTabStoppedAppleScript,
} from "./iterm2";

// Issue #183: values interpolated into AppleScript double-quoted string
// literals (tabTitle / tmuxSessionName / tabName / newName) were not escaped.
// A value containing `"` could terminate the literal early and inject
// arbitrary AppleScript (RW-045 same family: untrusted input → exec string).

describe("escapeAppleScriptString (choke point, AC-1)", () => {
  test("escapes a double quote to \\\"", () => {
    expect(escapeAppleScriptString('a"b')).toBe('a\\"b');
  });

  test("escapes a backslash to \\\\", () => {
    expect(escapeAppleScriptString("a\\b")).toBe("a\\\\b");
  });

  test("escapes backslash before quote (order matters)", () => {
    // Input `\"` must become `\\\"` (escaped backslash THEN escaped quote).
    // If the quote were escaped first, the result `\\"` would leave a
    // literal-terminating quote behind.
    expect(escapeAppleScriptString('\\"')).toBe('\\\\\\"');
  });

  test("leaves a normal channel name unchanged", () => {
    expect(escapeAppleScriptString("team-salary (running)")).toBe(
      "team-salary (running)"
    );
  });
});

describe("buildOpenTabAppleScript injection safety (AC-2)", () => {
  test("a tmuxSessionName containing a double quote stays a literal", () => {
    const malicious = 'claude-x" \n end tell \n do shell script "touch /tmp/pwned';
    const script = buildOpenTabAppleScript(malicious, "chan (running)", 1, 2, 3);
    // The write-text line must embed the escaped form, not a bare quote that
    // closes the `write text "..."` literal early.
    expect(script).toContain('\\"'); // an escaped quote is present
    // The raw injected statement (with surrounding quotes) must NOT appear.
    expect(script).not.toContain('do shell script "touch /tmp/pwned"');
  });

  test("a tabTitle containing a double quote is escaped in the set-name line", () => {
    const evil = 'x" then beep "';
    const script = buildOpenTabAppleScript("claude-1", `${evil} (running)`, 1, 2, 3);
    expect(script).toContain(`set name to "${escapeAppleScriptString(`${evil} (running)`)}"`);
    // Raw, unescaped injection is absent.
    expect(script).not.toMatch(/set name to "x" then beep/);
  });

  test("a benign session/title produces a script equal to the escaped form", () => {
    const script = buildOpenTabAppleScript("claude-12", "team (running)", 10, 20, 30);
    expect(script).toContain('set name to "team (running)"');
    expect(script).toContain("set background color to {10, 20, 30}");
  });
});

describe("buildMarkTabStoppedAppleScript injection safety (AC-2)", () => {
  test("a tabName containing a double quote cannot break the comparison literal", () => {
    const evil = 'x" then beep "';
    const script = buildMarkTabStoppedAppleScript(
      `${evil} (running)`,
      `${evil} (stopped)`
    );
    expect(script).toContain(
      `is "${escapeAppleScriptString(`${evil} (running)`)}"`
    );
    // Before escaping this would read `is "x" then beep ...` (raw injection).
    expect(script).not.toMatch(/is "x" then beep/);
  });

  test("a benign channel name renders the normal comparison", () => {
    const script = buildMarkTabStoppedAppleScript(
      "agent-base (running)",
      "agent-base (stopped)"
    );
    expect(script).toContain('is "agent-base (running)"');
    expect(script).toContain('set name to "agent-base (stopped)"');
  });
});
