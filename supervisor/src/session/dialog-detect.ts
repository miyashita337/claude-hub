/**
 * Dialog detection for tmux pane content.
 *
 * Issue #57: Even with `--dangerously-skip-permissions`, Claude Code's Ink
 * TUI can surface confirmation dialogs from sources outside the permission
 * system (Plan mode, AskUserQuestion tool, MCP elicitation, Bash interactive
 * y/n prompts). The PermissionRequest hook (Issue #11, see
 * `supervisor/hooks/auto-approve-permission.sh`) already handles tool
 * permission dialogs but cannot intercept these other dialog families.
 *
 * Without detection, the relay silently times out at RELAY_TIMEOUT_MS
 * (default 15 min, env-tunable) and the user perceives the bot as dead.
 * This module exposes a
 * pure function `detectDialog(paneText)` that callers (relay watchdog,
 * tests) can invoke against `tmux capture-pane -p` output.
 *
 * Design notes:
 *  - We restrict pattern matching to the last DETECT_WINDOW_LINES lines so
 *    a long scrollback containing a previously-dismissed dialog does not
 *    keep re-triggering. Dialogs render at the bottom of the pane.
 *  - Patterns are intentionally narrow. False positives (auto-pressing Enter
 *    on prose that merely *mentions* a dialog) cause real harm — they can
 *    accept a different prompt that legitimately needed user input. Prefer
 *    to miss a novel dialog (and timeout, which is observable) than to
 *    auto-accept the wrong thing.
 *  - Issue #423 applies that same principle to a whole family: AskUserQuestion
 *    exists to make a *human* decide, so it is detected as its own kind and is
 *    NEVER auto-accepted. Pressing a key there does not merely dismiss a
 *    dialog — it fabricates an answer that Claude cannot distinguish from the
 *    user's own, which is strictly worse than stalling (a stall is observable;
 *    a fabricated decision is not). It is matched BEFORE the auto-acceptable
 *    families so a question whose options happen to render like `1. Yes` /
 *    `2. No` cannot be classified as `numbered-choice`.
 *  - The matched line is returned so log lines can include the actual text
 *    that triggered detection — required for [Dialog] log entries to be
 *    useful when diagnosing false positives.
 */

export type DialogKind =
  | "ink-confirm"
  | "bash-yn"
  | "numbered-choice"
  | "press-enter"
  | "feedback-survey"
  | "ask-user-question";

export interface DialogMatch {
  /** Detected dialog family. */
  kind: DialogKind;
  /** Whether the watchdog may attempt auto-accept. False for
   *  {@link DialogKind} `ask-user-question` (Issue #423): the machine must not
   *  answer a question addressed to the user. The watchdog pages instead. */
  autoAcceptable: boolean;
  /** Line that triggered detection — used in `[Dialog]` log lines. */
  line: string;
}

/**
 * Keys to send via tmux send-keys to auto-accept each dialog kind.
 *
 *  - ink-confirm: `❯ Yes` is the default selection in Claude Code's Ink
 *    confirmation; pressing Enter selects it.
 *  - bash-yn: type 'y' then Enter. Capital N defaults are accepted by
 *    pressing 'y' explicitly (we don't try to detect default polarity).
 *  - numbered-choice: select option 1 (typically Yes/Continue).
 *  - press-enter: just Enter.
 *  - feedback-survey: select option 0 (Dismiss). Issue #153: Claude Code's
 *    "How is Claude doing this session?" survey looks like a numbered choice,
 *    but options 1/2/3 *submit* feedback (1 = "Bad"). Only `0` (Dismiss)
 *    clears it without side effects, so this kind MUST press 0, never 1.
 *  - ask-user-question: EMPTY on purpose (Issue #423). Every key in this
 *    dialog selects an option, and a selected option is delivered to Claude as
 *    the user's own decision. There is no "dismiss without side effects" key,
 *    so the only safe machine action is to send nothing and page the user.
 *    The map stays total over DialogKind so a new family cannot be added
 *    without deciding its keys, and the empty list is a second line of defence
 *    for any caller that forgets to check `autoAcceptable`.
 *
 * Each entry is an argv list passed to `tmux send-keys -t <session> ...`.
 * Multiple entries mean multiple sequential send-keys calls (with no
 * artificial delay; tmux handles ordering).
 */
export const AUTO_ACCEPT_KEYS: Record<DialogKind, string[]> = {
  "ink-confirm": ["C-m"],
  "bash-yn": ["y", "C-m"],
  "numbered-choice": ["1", "C-m"],
  "press-enter": ["C-m"],
  "feedback-survey": ["0", "C-m"],
  "ask-user-question": [],
};

/**
 * Options Claude Code appends to every AskUserQuestion picker in addition to
 * the model's own choices — the free-text entry and the "discuss it instead"
 * escape hatch. They are harness-rendered (not model- or user-authored), which
 * makes them the most reliable marker of "this dialog is asking the *user* to
 * decide".
 *
 * Evidence: pane capture in Issue #304 (Claude Code v2.1.228) shows
 *   `❯ 1. 案1: …` / `2. 案2: …` / `4. Type something.` / `5. Chat about this`
 * under the question header, with `Enter to select · ↑/↓ to navigate` below.
 *
 * A literal from the TUI is a fragile matcher in general (RW-027: a Claude Code
 * update silently broke a ready-marker pattern), so the consequences of drift
 * are deliberately asymmetric here:
 *  - marker present but not a question → we withhold auto-accept and page. Cost:
 *    one extra Discord heartbeat.
 *  - marker renamed by a future TUI → this kind stops matching; the dialog then
 *    falls through to the auto-acceptable families, which is exactly the #423
 *    hazard. `relay.ts` therefore ALSO suppresses auto-accept from supervisor
 *    state (an /ask POST was relayed for this thread moments ago), which needs
 *    no TUI literal at all. Keep both.
 */
const ASK_OPTION_MARKER =
  /^\s*(?:❯\s*)?\d+\.\s+(?:Type something\.?|Chat about this)\s*$/m;

/** Number of trailing lines to inspect. Dialogs render at the bottom of
 *  the visible pane; older content is scrollback noise. */
const DETECT_WINDOW_LINES = 30;

/**
 * Detect a dialog in the supplied pane snapshot.
 *
 * Returns the first match found in the last {@link DETECT_WINDOW_LINES}
 * lines, or null when no dialog pattern is present.
 */
export function detectDialog(paneText: string): DialogMatch | null {
  if (!paneText || !paneText.trim()) return null;

  const lines = paneText.split("\n");
  const window = lines.slice(-DETECT_WINDOW_LINES);
  const windowText = window.join("\n");

  // 0. Feedback satisfaction survey (Issue #153). Checked first as a safety
  //    guard. Today the survey's option line uses colons ("1: Bad ... 0:
  //    Dismiss") while numbered-choice (case 3) requires periods ("1. Yes"),
  //    so misclassification can't happen yet — but if a future TUI switches
  //    the survey to "1. Bad", numbered-choice would send `1` (= submit "Bad"
  //    feedback). Ordering this first future-proofs against that. We require
  //    BOTH the distinctive question and a `0: Dismiss` option so prose merely
  //    quoting the question doesn't trigger auto-dismiss.
  //    The i+4 lookahead window covers the question line plus the option line
  //    (adjacent in practice) with slack for a blank spacer line between them.
  for (let i = 0; i < window.length; i++) {
    const line = window[i] ?? "";
    if (/How is Claude doing this session\?/i.test(line)) {
      const lookahead = window.slice(i, i + 4).join("\n");
      if (/\b0\s*:\s*Dismiss\b/i.test(lookahead)) {
        return {
          kind: "feedback-survey",
          autoAcceptable: true,
          line: line.trim(),
        };
      }
    }
  }

  // 0.5. AskUserQuestion (Issue #423). Checked before every auto-acceptable
  //    family: a question rendered as `1. Yes` / `2. No` would otherwise match
  //    `numbered-choice` (case 3) and be answered with option 1 — the exact
  //    incident this kind exists to prevent, where two decisions were
  //    fabricated and three issues were designed on top of them.
  //    It cannot collide with `feedback-survey` (case 0, which requires the
  //    survey question plus a `0: Dismiss` option), so that kind keeps its
  //    documented first position and still gets auto-dismissed.
  const askMatch = windowText.match(ASK_OPTION_MARKER);
  if (askMatch) {
    return {
      kind: "ask-user-question",
      autoAcceptable: false,
      line: askMatch[0].trim(),
    };
  }

  // 1. Ink-style confirm: lines beginning with "❯ Yes" (the cursor marker)
  //    plus an adjacent "No" option line. We require the cursor symbol so
  //    arbitrary prose containing "Yes" / "No" doesn't match.
  for (let i = 0; i < window.length; i++) {
    const line = window[i] ?? "";
    if (/^\s*❯\s+Yes\b/.test(line)) {
      const lookahead = window.slice(i, i + 4).join("\n");
      if (/(?:^|\n)\s*(?:❯\s+)?No\b/.test(lookahead)) {
        return { kind: "ink-confirm", autoAcceptable: true, line: line.trim() };
      }
    }
  }

  // 2. Bash-style "(y/n)" / "[y/N]" prompt. Require the parens/brackets so
  //    we don't match URLs (`?y=1&n=2`) or prose ("yes or no").
  const ynMatch = windowText.match(/^.*?[(\[][YyNn]\/[YyNn][)\]].*$/m);
  if (ynMatch) {
    return { kind: "bash-yn", autoAcceptable: true, line: ynMatch[0].trim() };
  }

  // 3. Numbered choice ("1. Yes" + "2. No"). Both entries must be visible
  //    on adjacent (or near-adjacent) lines for it to qualify as a dialog.
  for (let i = 0; i < window.length; i++) {
    const line = window[i] ?? "";
    if (/^\s*1\.\s+Yes\b/i.test(line)) {
      const lookahead = window.slice(i, i + 4).join("\n");
      if (/\n\s*2\.\s+No\b/i.test(lookahead)) {
        return {
          kind: "numbered-choice",
          autoAcceptable: true,
          line: line.trim(),
        };
      }
    }
  }

  // 4. "Press <key> to continue".
  const pressMatch = windowText.match(
    /^.*Press\s+(?:Enter|any\s+key|return|\[Enter\])\s+to\s+continue.*$/im
  );
  if (pressMatch) {
    return {
      kind: "press-enter",
      autoAcceptable: true,
      line: pressMatch[0].trim(),
    };
  }

  return null;
}
