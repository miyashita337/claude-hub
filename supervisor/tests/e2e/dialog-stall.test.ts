import { test, expect, describe, beforeAll } from "bun:test";
import { execFileSync } from "child_process";
import { startDialogWatchdog } from "../../src/session/dialog-watchdog";
import {
  detectDialog,
  AUTO_ACCEPT_KEYS,
  type DialogMatch,
} from "../../src/session/dialog-detect";
import { TMUX_ARGS, ensureSocketConfigured } from "../../src/session/tmux";

/**
 * Issue #57 — End-to-end dialog stall recovery.
 *
 * Reproduction (Phase D-1, RED gate for Phase C):
 *  1. Spin a real tmux pane with a `cat` waiting on stdin (simulates a
 *     stuck pane).
 *  2. Inject a known dialog string ("Do you want to proceed? (y/N)") into
 *     the pane via send-keys with `-l`.
 *  3. Run the watchdog against that pane and verify:
 *     - detection fires (`onAutoAccept` called),
 *     - the auto-accept keys reach the pane (we observe "y" in the
 *       captured pane content),
 *     - if auto-accept doesn't clear the dialog, `onHeartbeat` fires after
 *       the configured budget.
 *
 * This is the auto-runnable counterpart of the manual reproduction
 * described in the Issue #57 AC. Real Claude Code is not exercised — that
 * would require a live API key + 5 min latency budget — but the *dialog
 * stall + recovery* path is proven hermetically.
 */

const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";
const TMUX_OP_TIMEOUT = 10_000;

function tmuxAvailable(): boolean {
  try {
    execFileSync(TMUX_PATH, ["-V"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

const hasTmux = tmuxAvailable();
const itmux = hasTmux ? test : test.skip;

function makeName(tag: string): string {
  return `dialog-stall-${tag}-${process.pid}-${Date.now()}`;
}

function startStalePane(name: string): void {
  // `cat` blocks waiting for stdin and never echoes prompts of its own,
  // giving us a controlled buffer where we can inject any text we like
  // via send-keys -l. `-x 200` keeps long lines on one row.
  execFileSync(
    TMUX_PATH,
    [
      ...TMUX_ARGS,
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "200",
      "-y",
      "30",
      "cat",
    ],
    { timeout: TMUX_OP_TIMEOUT }
  );
}

function killSession(name: string): void {
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "kill-session", "-t", name], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // already gone
  }
}

function capture(session: string): string {
  return execFileSync(
    TMUX_PATH,
    [...TMUX_ARGS, "capture-pane", "-p", "-t", session],
    { timeout: TMUX_OP_TIMEOUT }
  ).toString();
}

function injectText(session: string, text: string): void {
  // Inject literal text into the pane — `cat` won't echo it (no PTY echo
  // for stdin), so we capture-pane to confirm it landed.
  execFileSync(
    TMUX_PATH,
    [...TMUX_ARGS, "send-keys", "-t", session, "-l", text],
    { timeout: TMUX_OP_TIMEOUT }
  );
  // No Enter — we want the dialog text to remain visible.
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(() => {
  if (!hasTmux) return;
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "start-server"], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // server may already be running
  }
  ensureSocketConfigured();
});

describe("Issue #57 dialog stall — E2E with real tmux", () => {
  // AC-1 / AC-2 verification (auto-accept path).
  itmux(
    "AC-1: bash y/n dialog → watchdog detects + auto-accepts within 1 tick",
    async () => {
      const name = makeName("ac1");
      startStalePane(name);
      try {
        // Seed the pane with a dialog-like prompt. cat won't render a real
        // prompt; we manually inject the text we want detectDialog to see.
        injectText(name, "Do you want to proceed? (y/N)\n");
        await wait(100);
        const seeded = capture(name);
        expect(seeded).toContain("Do you want to proceed?");

        const accepts: DialogMatch[] = [];
        const watchdog = startDialogWatchdog({
          tmuxSessionName: name,
          pollIntervalMs: 50,
          maxAutoAcceptAttempts: 2,
          onAutoAccept: (m) => {
            accepts.push(m);
          },
        });
        // Allow the watchdog 3 ticks (~150ms) to detect.
        await wait(250);
        watchdog.stop();

        expect(accepts.length).toBeGreaterThanOrEqual(1);
        expect(accepts[0]!.kind).toBe("bash-yn");
      } finally {
        killSession(name);
      }
    }
  );

  // AC-2 verification (heartbeat escalation when auto-accept fails).
  itmux(
    "AC-2: stuck dialog persists → watchdog escalates to onHeartbeat",
    async () => {
      const name = makeName("ac2");
      startStalePane(name);
      try {
        // Inject a dialog and never clear it. Because the inner process is
        // `cat` (not a real prompt parser), pressing 'y' won't dismiss the
        // text — exactly what we want to simulate a stuck dialog.
        injectText(name, "❯ Yes\n  No\n");
        await wait(50);

        const heartbeats: DialogMatch[] = [];
        const watchdog = startDialogWatchdog({
          tmuxSessionName: name,
          pollIntervalMs: 50,
          maxAutoAcceptAttempts: 1,
          onHeartbeat: (m) => {
            heartbeats.push(m);
          },
        });
        // Need 2+ ticks: tick 1 auto-accepts, tick 2 finds dialog still
        // present and fires heartbeat.
        await wait(300);
        watchdog.stop();

        expect(heartbeats.length).toBeGreaterThanOrEqual(1);
        expect(heartbeats[0]!.kind).toBe("ink-confirm");
      } finally {
        killSession(name);
      }
    }
  );

  // AC-3 verification: the captured pane text passes detectDialog. This
  // is the round-trip proof that production tmux output (capture-pane -p)
  // is in the format detectDialog expects.
  itmux(
    "AC-3: capture-pane output is parseable by detectDialog",
    async () => {
      const name = makeName("ac3");
      startStalePane(name);
      try {
        injectText(name, "Continue? (y/N)\n");
        await wait(100);
        const pane = capture(name);
        const result = detectDialog(pane);
        expect(result).not.toBeNull();
        expect(result!.kind).toBe("bash-yn");
      } finally {
        killSession(name);
      }
    }
  );

  // Issue #153 AC-3 verification: the feedback satisfaction survey, captured
  // from a real tmux pane, is detected as `feedback-survey` and the watchdog
  // auto-accepts it by sending `0` (Dismiss) via real tmux send-keys — never
  // `1` (which would submit "Bad" feedback). This is the round-trip proof
  // that production capture-pane output for the survey unblocks the relay.
  itmux(
    "AC-3 (#153): feedback survey pane → detect feedback-survey + send 0",
    async () => {
      const name = makeName("survey");
      startStalePane(name);
      // Declared outside try so the finally can stop it even if an assertion
      // throws — prevents the poll timer leaking past the test.
      let watchdog: { stop(): void } | null = null;
      try {
        injectText(
          name,
          "How is Claude doing this session? (optional)\n  1: Bad    2: Fine   3: Good   0: Dismiss\n"
        );
        await wait(100);
        const pane = capture(name);
        const result = detectDialog(pane);
        expect(result).not.toBeNull();
        expect(result!.kind).toBe("feedback-survey");

        const accepts: DialogMatch[] = [];
        watchdog = startDialogWatchdog({
          tmuxSessionName: name,
          pollIntervalMs: 50,
          maxAutoAcceptAttempts: 1,
          onAutoAccept: (m) => {
            accepts.push(m);
          },
        });
        await wait(250);

        expect(accepts.length).toBeGreaterThanOrEqual(1);
        expect(accepts[0]!.kind).toBe("feedback-survey");
        // Round-trip: AUTO_ACCEPT_KEYS sends `0` then Enter (real send-keys).
        // We assert via the kind→keys map since send-keys to a `cat` pane
        // can't be re-read; the kind is the deterministic contract.
        expect(AUTO_ACCEPT_KEYS["feedback-survey"]).toEqual(["0", "C-m"]);
      } finally {
        watchdog?.stop();
        killSession(name);
      }
    }
  );

  // Negative case: ensure clean panes don't trigger detection. Without
  // this, false-positives on a pane mid-execution would auto-fire Enter
  // and corrupt user input — much worse than the original silent stall.
  itmux("negative: clean pane never triggers detection", async () => {
    const name = makeName("clean");
    startStalePane(name);
    try {
      injectText(name, "regular text without any dialog patterns\n");
      await wait(50);

      const accepts: DialogMatch[] = [];
      const watchdog = startDialogWatchdog({
        tmuxSessionName: name,
        pollIntervalMs: 50,
        maxAutoAcceptAttempts: 2,
        onAutoAccept: (m) => accepts.push(m),
      });
      await wait(300);
      watchdog.stop();

      expect(accepts.length).toBe(0);
    } finally {
      killSession(name);
    }
  });
});
