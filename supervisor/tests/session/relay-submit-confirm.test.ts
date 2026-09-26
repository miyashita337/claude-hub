import { test, expect, describe, beforeAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  sendToPane,
  SUBMIT_MAX_ENTER_ATTEMPTS,
  type PaneReader,
} from "../../src/session/relay";
import { SUBMIT_UNCONFIRMED_USER_MESSAGE } from "../../src/session/dialog-stuck-handler";
import { TMUX_ARGS, ensureSocketConfigured } from "../../src/session/tmux";

/**
 * Issue #357 (dup #263): "Discord→Claude Code 中継で入力が送信(Enter)されず未確定の
 * まま stall".
 *
 * `sendToPane` proved (#422) that the literal reached the pane, but it sent
 * `C-m` blind: an Enter the TUI dropped left the message sitting un-submitted in
 * the input box until the stall heartbeat told the user to `tmux attach`.
 *
 * These tests drive a pane whose foreground program behaves like an input box:
 * it echoes what is typed and "submits" (prints SUBMITTED) on Enter — except for
 * the first N Enters, which it swallows without a trace, exactly like the
 * dropped Enter in the incident. The contract under test:
 *
 *   - Enter honoured first time   → "submitted", one submission
 *   - first Enter dropped         → Enter re-sent, "submitted-after-resend",
 *                                   still exactly one submission
 *   - every Enter dropped         → bounded re-sends, "unconfirmed" (no throw:
 *                                   the text IS in the pane, the user is told)
 *   - observer unavailable        → "not-checked", one blind Enter (pre-#357)
 */

const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";
const TMUX_OP_TIMEOUT = 10000;

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

const FAST_BACKOFF = [30, 60, 120, 240] as const;
const READY_MARKER = "INPUTBOX_READY";

function makeSessionName(tag: string): string {
  return `relay357-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
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

function capturePane(session: string): string {
  return execFileSync(TMUX_PATH, [...TMUX_ARGS, "capture-pane", "-p", "-t", session], {
    timeout: TMUX_OP_TIMEOUT,
  }).toString();
}

function countSubmissions(pane: string): number {
  return (pane.match(/SUBMITTED/g) ?? []).length;
}

/**
 * Start a pane that behaves like the TUI input box: raw mode, echo each typed
 * character itself, submit on Enter — but swallow the first `dropEnters` Enters.
 * `dropEnters < 0` swallows every Enter (the persistent stall).
 */
function startInputBoxPane(name: string, dir: string, dropEnters: number): void {
  const script = join(dir, "input-box.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -u
stty -icanon -echo -icrnl
drops=${dropEnters}
printf '${READY_MARKER}\\n'
while IFS= read -r -n1 -d '' c; do
  # sendToPane clears modals with Escape first; the TUI swallows it, and so must
  # this stand-in (echoing ESC would start an escape sequence and eat the text).
  if [ "$c" = $'\\e' ]; then
    continue
  fi
  # Enter: bash's read -n restores ICRNL on the tty, so C-m may arrive as LF.
  if [ "$c" = $'\\r' ] || [ "$c" = $'\\n' ]; then
    if [ "$drops" -ne 0 ]; then
      drops=$((drops - 1))
      continue
    fi
    printf '\\nSUBMITTED\\n'
  else
    printf '%s' "$c"
  fi
done
`
  );
  chmodSync(script, 0o755);
  execFileSync(
    TMUX_PATH,
    [...TMUX_ARGS, "new-session", "-d", "-s", name, "-x", "200", "-y", "40", "bash", script],
    { timeout: TMUX_OP_TIMEOUT }
  );
}

async function waitForReady(name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (capturePane(name).includes(READY_MARKER)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`input-box pane ${name} never reported ${READY_MARKER}`);
}

beforeAll(async () => {
  if (!hasTmux) return;
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "start-server"], { timeout: TMUX_OP_TIMEOUT });
  } catch {
    // non-fatal; new-session starts the server on demand
  }
  await ensureSocketConfigured();
});

describe("submit confirmation after Enter (#357)", () => {
  const payload = "team_salaryにdispatch 依頼。/goal 草案ができたらissueに書き出し";

  itmux(
    "AC-1: an Enter honoured first time is 'submitted' with one submission",
    async () => {
      const name = makeSessionName("ok");
      const dir = mkdtempSync(join(tmpdir(), "relay357-ok-"));
      startInputBoxPane(name, dir, 0);
      try {
        await waitForReady(name);
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
        });
        expect(outcome.verdict).toBe("verified");
        expect(outcome.submit).toBe("submitted");
        expect(countSubmissions(capturePane(name))).toBe(1);
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  itmux(
    "AC-2: a dropped Enter is detected and re-sent, submitting exactly once",
    async () => {
      const name = makeSessionName("drop1");
      const dir = mkdtempSync(join(tmpdir(), "relay357-drop1-"));
      startInputBoxPane(name, dir, 1);
      try {
        await waitForReady(name);
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
        });
        // Pre-fix: a single blind C-m → the text stayed un-submitted in the box.
        expect(outcome.submit).toBe("submitted-after-resend");
        expect(countSubmissions(capturePane(name))).toBe(1);
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  itmux(
    "AC-3: when every Enter is dropped the send reports 'unconfirmed' after bounded re-sends",
    async () => {
      const name = makeSessionName("dropall");
      const dir = mkdtempSync(join(tmpdir(), "relay357-dropall-"));
      startInputBoxPane(name, dir, -1);
      try {
        await waitForReady(name);
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
        });
        // The text did reach the pane, so this is not a send failure (no throw)…
        expect(outcome.verified).toBe(true);
        // …but it is not submitted, and the caller must be able to tell.
        expect(outcome.submit).toBe("unconfirmed");
        expect(countSubmissions(capturePane(name))).toBe(0);
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  itmux(
    "an unavailable observer falls back to one blind Enter ('not-checked')",
    async () => {
      const name = makeSessionName("noobs");
      const dir = mkdtempSync(join(tmpdir(), "relay357-noobs-"));
      startInputBoxPane(name, dir, 0);
      try {
        await waitForReady(name);
        const nullReader: PaneReader = async () => null;
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          capturePane: nullReader,
          capturePaneState: nullReader,
        });
        expect(outcome.submit).toBe("not-checked");
        expect(countSubmissions(capturePane(name))).toBe(1);
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );
});

describe("an ever-changing pane is not mistaken for a confirmed submit (#357)", () => {
  itmux(
    "a pane that never settles (spinner / live statusline) yields 'not-checked' with one Enter",
    async () => {
      const name = makeSessionName("anim");
      const dir = mkdtempSync(join(tmpdir(), "relay357-anim-"));
      startInputBoxPane(name, dir, 0);
      try {
        await waitForReady(name);
        let tick = 0;
        const animated: PaneReader = async () => `frame ${tick++}`;
        const outcome = await sendToPane(name, "hello there", TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          capturePaneState: animated,
        });
        // "Changed after Enter" is meaningless here, so no confirmation is claimed.
        expect(outcome.submit).toBe("not-checked");
        expect(countSubmissions(capturePane(name))).toBe(1);
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );
});

describe("relayMessage pages the thread when Enter never submits (#357)", () => {
  itmux(
    "AC-4: an unconfirmed submit is reported to Discord immediately, not after the stall timer",
    async () => {
      const { relayMessage } = await import("../../src/session/relay");
      const { cancelRelay } = await import("../../src/session/relay-server");
      const { setLatencyLogPath } = await import("../../src/session/latency-logger");
      const name = makeSessionName("relay");
      const dir = mkdtempSync(join(tmpdir(), "relay357-relay-"));
      setLatencyLogPath(join(dir, "latency.jsonl"));
      startInputBoxPane(name, dir, -1);
      const threadId = `thread-357-${process.pid}-${Date.now()}`;
      const pages: { kind: string; tmuxSessionName: string }[] = [];
      try {
        await waitForReady(name);
        const started = Date.now();
        const result = await relayMessage(name, threadId, "長文の依頼 /goal 草案", {
          onDialogStuck: (info) => {
            pages.push(info);
            // The user now has a recovery path; end the wait for the test.
            cancelRelay(threadId);
          },
        });
        expect(pages).toHaveLength(1);
        expect(pages[0]!.kind).toBe("unsubmitted");
        expect(pages[0]!.tmuxSessionName).toBe(name);
        // Well before the 3-min stall heartbeat that used to be the only signal.
        expect(Date.now() - started).toBeLessThan(60_000);
        expect(result.error).toBe("Cancelled");
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000
  );
});

describe("submit confirmation policy (#357)", () => {
  test("Enter re-sends are bounded", () => {
    // Unbounded re-sends into a pane that never reacts would just spin; a
    // re-send is only safe because nothing visibly happened after the last one.
    expect(SUBMIT_MAX_ENTER_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(SUBMIT_MAX_ENTER_ATTEMPTS).toBeLessThanOrEqual(4);
  });

  test("the unconfirmed notice offers a Discord-only recovery, no tmux internals", () => {
    expect(SUBMIT_UNCONFIRMED_USER_MESSAGE).toContain("/session enter");
    expect(SUBMIT_UNCONFIRMED_USER_MESSAGE).not.toMatch(/send-keys|capture-pane|C-m/);
  });
});
