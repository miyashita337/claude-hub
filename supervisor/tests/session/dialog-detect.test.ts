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

  // Issue #153: Claude Code's feedback satisfaction survey ("How is Claude
  // doing this session?") renders as a numbered-choice lookalike but the
  // numeric options (1: Bad / 2: Fine / 3: Good) are *survey answers* with
  // side effects, not a Yes/Continue confirmation. Sending `1` would submit
  // negative feedback. We auto-press `0` (Dismiss) instead. This must be
  // detected as its own kind so AUTO_ACCEPT_KEYS picks `0`, never `1`.
  test("detects feedback survey: 'How is Claude doing this session?'", () => {
    const pane = [
      "⎿  API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
      "   Request ID: req_011CbJu5U5eDtnPErMPtpnXP",
      "",
      "● How is Claude doing this session? (optional)",
      "  1: Bad    2: Fine   3: Good   0: Dismiss",
    ].join("\n");
    const result = detectDialog(pane);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("feedback-survey");
    expect(result!.autoAcceptable).toBe(true);
  });

  test("feedback survey takes priority over numbered-choice (never sends 1)", () => {
    // The survey's `0: Dismiss` line resembles a numbered choice. Ensure the
    // detector classifies it as feedback-survey so AUTO_ACCEPT sends `0`.
    const pane = [
      "● How is Claude doing this session? (optional)",
      "  1: Bad    2: Fine   3: Good   0: Dismiss",
    ].join("\n");
    const result = detectDialog(pane);
    expect(result!.kind).toBe("feedback-survey");
    expect(AUTO_ACCEPT_KEYS[result!.kind]).toEqual(["0", "C-m"]);
  });

  test("does NOT match the survey question as prose without the options line", () => {
    // The question alone (e.g. quoted in a chat message) must not trigger —
    // we require the numbered options line with `0: Dismiss` to be present.
    expect(
      detectDialog("Someone asked: how is Claude doing this session?")
    ).toBeNull();
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
    expect(AUTO_ACCEPT_KEYS["feedback-survey"]).toEqual(["0", "C-m"]);
    // Issue #423: no key is safe to press in an AskUserQuestion — every one of
    // them selects an option and reports it to Claude as the user's decision.
    expect(AUTO_ACCEPT_KEYS["ask-user-question"]).toEqual([]);
  });
});

/**
 * Issue #423. On 2026-08-12 two AskUserQuestion prompts were "answered" without
 * the 会長 touching anything: the /ask relay died in ~13s (#416), the hook fell
 * back to the TUI, and the watchdog auto-accepted the resulting dialog with
 * option 1. Three issues were then designed on top of the fabricated decisions.
 *
 * The pane fixtures below follow the capture attached to Issue #304 (Claude Code
 * v2.1.228): the question, the model's options, then the harness-appended
 * `N. Type something.` / `N. Chat about this` affordances and a navigation
 * footer.
 */
describe("detectDialog — AskUserQuestion is never auto-accepted (Issue #423)", () => {
  const askPane = [
    "□ 受信経路",
    "タップ後に Mac で実行する受信経路はどれにしますか？",
    "",
    "❯ 1. 案1: Tailscale HTTP receiver（推奨）",
    "     タップ1回で完結。claude-hub supervisor に受信エンドポイントを同居。",
    "  2. 案2: Discord 経由",
    "  3. 案3: iOS ショートカット + SSH",
    "  4. Type something.",
    "",
    "  5. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");

  test("detects the AskUserQuestion picker and refuses auto-accept", () => {
    const result = detectDialog(askPane);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("ask-user-question");
    expect(result!.autoAcceptable).toBe(false);
  });

  test("wins over numbered-choice when the options render as 1. Yes / 2. No", () => {
    // The incident shape: a binary question whose options match the
    // `numbered-choice` pattern exactly. Before #423 this was classified as
    // numbered-choice and answered with `1` — i.e. the user's decision was
    // invented. Ordering in detectDialog is what prevents it, so assert the
    // classification, not just "not auto-acceptable".
    const yesNoPane = [
      "□ 方針確認",
      "この方針で進めますか？",
      "",
      "  1. Yes — 推奨案で進める",
      "  2. No — 別案を検討する",
      "  3. Type something.",
      "",
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");

    // Guard: without the affordance lines this pane IS a numbered-choice, so
    // the test above is exercising the ordering and not a shape that never
    // matched numbered-choice in the first place.
    const withoutAffordances = detectDialog(
      ["  1. Yes — 推奨案で進める", "  2. No — 別案を検討する"].join("\n"),
    );
    expect(withoutAffordances!.kind).toBe("numbered-choice");

    const result = detectDialog(yesNoPane);
    expect(result!.kind).toBe("ask-user-question");
    expect(result!.autoAcceptable).toBe(false);
  });

  test("the feedback survey keeps its first-position dismissal (no collision)", () => {
    // ask-user-question is checked before the auto-acceptable families but
    // AFTER the survey, so the survey is still dismissed with `0` (#153).
    const survey = [
      "● How is Claude doing this session? (optional)",
      "1: Bad  2: OK  3: Good  0: Dismiss",
    ].join("\n");
    expect(detectDialog(survey)!.kind).toBe("feedback-survey");
  });

  test("does not disturb the ordinary auto-acceptable families", () => {
    expect(detectDialog("Permission required\n  ❯ Yes\n    No\n")!.kind).toBe(
      "ink-confirm",
    );
    expect(detectDialog("rm -rf x\nProceed? (y/N)\n")!.kind).toBe("bash-yn");
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
