import { test, expect, describe } from "bun:test";
import { detectDialog, AUTO_ACCEPT_KEYS } from "../../src/session/dialog-detect";

/**
 * Unit tests for dialog pattern detection.
 *
 * Issue #57: Even with `--dangerously-skip-permissions` set, Claude Code's
 * Ink TUI can still surface confirmation dialogs from sources outside the
 * permission system:
 *  - Plan mode confirmation
 *  - AskUserQuestion tool (model-initiated)
 *  - MCP elicitation
 *  - Bash interactive prompts (y/n) leaking to the pane
 *
 * The PermissionRequest hook already covers tool permission dialogs (Issue
 * #11) but cannot intercept these. Without detection the relay silently
 * times out at RELAY_TIMEOUT_MS (5 min), and the user perceives the bot as
 * dead.
 *
 * The detector is a pure function so it is cheap to add coverage for every
 * known dialog shape we observe in production. New patterns should land here
 * with both a positive case (the dialog *is* detected) and a negative case
 * proving we don't false-positive on adjacent prose.
 */

describe("detectDialog — Claude Code TUI dialogs", () => {
  test("detects classic Ink confirmation: ❯ Yes / ❯ No", () => {
    const pane = [
      "Permission required to write to .claude/commands/foo.md",
      "  ❯ Yes",
      "    No",
    ].join("\n");
    const result = detectDialog(pane);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("ink-confirm");
    expect(result!.autoAcceptable).toBe(true);
  });

  test("detects ❯ Yes + ❯ No pair (both on cursor) — elicitation style", () => {
    const pane = [
      "Plan mode confirmation",
      "❯ Yes",
      "❯ No, change something",
    ].join("\n");
    const result = detectDialog(pane);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("ink-confirm");
  });

  test("detects 'Do you want to proceed?' (Bash interactive)", () => {
    const pane = [
      "rm -rf /tmp/old-files/*",
      "Do you want to proceed? (y/N)",
    ].join("\n");
    const result = detectDialog(pane);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("bash-yn");
  });

  test("detects '(y/n)' lowercase variants", () => {
    expect(detectDialog("Continue? (y/n)")?.kind).toBe("bash-yn");
    expect(detectDialog("Continue? (Y/n)")?.kind).toBe("bash-yn");
    expect(detectDialog("Continue? (y/N)")?.kind).toBe("bash-yn");
    expect(detectDialog("Continue? [y/N]")?.kind).toBe("bash-yn");
  });

  test("detects numbered choice prompts (1. Yes, 2. No)", () => {
    const pane = [
      "Do you want to enable plan mode?",
      "  1. Yes",
      "  2. No, exit",
    ].join("\n");
    const result = detectDialog(pane);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("numbered-choice");
  });

  test("detects 'Press Enter to continue'", () => {
    const result = detectDialog("Press Enter to continue...");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("press-enter");
    expect(result!.autoAcceptable).toBe(true);
  });

  test("does NOT match prose containing 'yes' or 'no' words", () => {
    expect(detectDialog("Yes, the answer is correct.")).toBeNull();
    expect(
      detectDialog("Reply: yes I think this approach works no further changes needed.")
    ).toBeNull();
  });

  test("does NOT match URLs containing y/n-like fragments", () => {
    expect(detectDialog("https://example.com/path?yes=1&no=2")).toBeNull();
  });

  test("does NOT match code samples mentioning prompts", () => {
    // The exact string `(y/n)` inside a code fence triple-backtick block could
    // legitimately appear; we accept a tiny false-positive risk here, but at
    // minimum prose mentioning 'proceed' alone should not trigger.
    expect(detectDialog("We will proceed with the deployment.")).toBeNull();
  });

  test("returns null on empty / whitespace pane", () => {
    expect(detectDialog("")).toBeNull();
    expect(detectDialog("   \n  \n  ")).toBeNull();
  });

  test("returns the matched line for observability", () => {
    const pane = "Some output\n  ❯ Yes\n  No\n";
    const result = detectDialog(pane);
    expect(result?.line).toContain("Yes");
  });

  test("AUTO_ACCEPT_KEYS map exports keys for each dialog kind", () => {
    expect(AUTO_ACCEPT_KEYS["ink-confirm"]).toEqual(["C-m"]);
    expect(AUTO_ACCEPT_KEYS["bash-yn"]).toEqual(["y", "C-m"]);
    expect(AUTO_ACCEPT_KEYS["numbered-choice"]).toEqual(["1", "C-m"]);
    expect(AUTO_ACCEPT_KEYS["press-enter"]).toEqual(["C-m"]);
  });
});

describe("detectDialog — last-N-lines window", () => {
  test("only inspects the bottom ~30 lines (avoid stale dialog text in scrollback)", () => {
    // Old dialog text 100 lines up should not trigger detection; otherwise
    // a long-running session that previously dismissed a dialog would keep
    // re-firing the watchdog. The last-line window keeps detection tied to
    // what's currently on screen.
    const ancient = "❯ Yes\n  No\n";
    const recent = Array.from({ length: 100 }, (_, i) => `log line ${i}`).join("\n");
    const pane = ancient + "\n" + recent;
    const result = detectDialog(pane);
    expect(result).toBeNull();
  });
});
