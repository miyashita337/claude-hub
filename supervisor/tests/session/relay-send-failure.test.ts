import { test, expect, describe } from "bun:test";
import {
  buildSendFailureResult,
  SEND_FAILURE_USER_MESSAGE,
} from "../../src/session/relay";

/**
 * Issue #74: "Session stop 後なのにメッセージが来てる".
 *
 * Confirmed root cause (see issue's 再現手順): when `sendToPane` fails — pane
 * stuck in copy-mode → tmux returns `not in a mode`, or ETIMEDOUT under load
 * (Issue #73 / RW-019) — the relay catch path used to interpolate `${err}`
 * straight into a Discord chunk. The raw `tmux send-keys ...` command line and
 * the bare `not in a mode` string were posted to the thread as if they were
 * Claude's reply (screenshot in #74: `not in a mode` ×5).
 *
 * These tests are pure (no tmux) and lock the contract: a send failure yields a
 * clean, actionable user notice with NO raw tmux internals, while the raw cause
 * is still preserved in `RelayResult.error` for diagnostics/logs.
 */
describe("relay send-keys failure does not leak tmux internals (#74)", () => {
  // The exact error string observed in supervisor.stdout.log for the #74 thread.
  const rawErr = new Error(
    "Command failed: /opt/homebrew/bin/tmux send-keys -t claude-149565894251 -l Skill...\nnot in a mode"
  );

  test("user-facing chunk contains no raw tmux internals", () => {
    const result = buildSendFailureResult(rawErr);
    expect(result.chunks).toHaveLength(1);
    const chunk = result.chunks[0]!;
    // The exact symptom from the #74 screenshot must never reach Discord.
    expect(chunk).not.toMatch(/not in a mode/i);
    expect(chunk).not.toMatch(/send-keys/i);
    expect(chunk).not.toMatch(/Command failed/i);
    expect(chunk).not.toMatch(/tmux/i);
    expect(chunk).toBe(SEND_FAILURE_USER_MESSAGE);
  });

  test("raw cause is preserved in error for diagnostics", () => {
    const result = buildSendFailureResult(rawErr);
    expect(result.error).toContain("not in a mode");
    expect(result.error).toContain("send-keys");
    expect(result.text).toBe("");
  });

  test("the canned message is clean and actionable", () => {
    expect(SEND_FAILURE_USER_MESSAGE).not.toMatch(/not in a mode|tmux|send-keys/i);
    // Actionable: tells the user how to recover. (#236 corrected the wording —
    // it used to name `/session restart`, which is not a registered subcommand.
    // tests/session/relay-error-notice.test.ts enforces that mechanically.)
    expect(SEND_FAILURE_USER_MESSAGE).toContain("/session start");
  });

  test("handles non-Error throwables without leaking", () => {
    // execFileSync can throw objects whose String() still embeds the command.
    const weird = { toString: () => "tmux send-keys ... not in a mode" };
    const result = buildSendFailureResult(weird);
    expect(result.chunks[0]).toBe(SEND_FAILURE_USER_MESSAGE);
    expect(result.chunks[0]).not.toMatch(/not in a mode/i);
    expect(result.error).toContain("not in a mode"); // still captured for logs
  });

  test("handles a bare string throwable without leaking", () => {
    // Defensive: a `throw "raw tmux string"` must also be sanitized.
    const result = buildSendFailureResult("tmux send-keys -t x not in a mode");
    expect(result.chunks[0]).toBe(SEND_FAILURE_USER_MESSAGE);
    expect(result.chunks[0]).not.toMatch(/not in a mode|tmux|send-keys/i);
    expect(result.error).toContain("not in a mode");
  });
});
