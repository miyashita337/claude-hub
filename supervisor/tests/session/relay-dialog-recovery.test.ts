import { test, expect, describe, beforeAll } from "bun:test";
import { execFileSync } from "child_process";
import {
  sendWithDialogRecovery,
  sendToPane,
  buildSendFailureResult,
  DialogBlockedSendError,
  SEND_UNVERIFIED_ERROR,
  SEND_FAILURE_USER_MESSAGE,
  type SendOutcome,
} from "../../src/session/relay";
import { TMUX_ARGS, TMUX_PATH, ensureSocketConfigured } from "../../src/session/tmux";

/**
 * Issue #562: a dialog that opened OUTSIDE a relay turn (right after launch in
 * the 2026-11-10 incident) made every send fail with SEND_UNVERIFIED, and the
 * dialog watchdog — which only runs after a send succeeded — never looked at
 * the pane. The session stayed stuck for ~4 hours.
 *
 * sendWithDialogRecovery gives the failing send one look at the pane.
 */

const INCIDENT_DIALOG = [
  "  Toggle thinking mode",
  "  Enable or disable thinking for this session.",
  "",
  "  ❯ 1. Enabled ✔  Claude will think before responding",
  "    2. Disabled   Claude will respond without extended thinking",
  "",
  "  Enter to confirm · Esc to cancel",
].join("\n");

const ASK_DIALOG = [
  "  どちらで進めますか？",
  "  ❯ 1. 案A",
  "    2. 案B",
  "    3. Type something.",
  "    4. Chat about this",
].join("\n");

const OK: SendOutcome = { verdict: "verified", verified: true, submit: "submitted" };

/** A `send` that fails `failures` times with SEND_UNVERIFIED, then succeeds. */
function scriptedSend(failures: number) {
  let calls = 0;
  const send = async (): Promise<SendOutcome> => {
    calls++;
    if (calls <= failures) throw new Error(SEND_UNVERIFIED_ERROR);
    return OK;
  };
  return { send, calls: () => calls };
}

function keyRecorder() {
  const sent: string[][] = [];
  return { sendKeys: (_s: string, keys: string[]) => void sent.push(keys), sent };
}

describe("sendWithDialogRecovery (#562)", () => {
  test("Journey AC 1: auto-acceptable dialog → keys sent, resent once, delivered", async () => {
    const s = scriptedSend(1);
    const k = keyRecorder();
    const outcome = await sendWithDialogRecovery("claude-x", s.send, {
      retypeAllowed: true,
      capture: () => INCIDENT_DIALOG,
      sendKeys: k.sendKeys,
      settleMs: 0,
    });
    expect(outcome).toEqual(OK);
    expect(k.sent).toEqual([["C-m"]]);
    expect(s.calls()).toBe(2);
  });

  test("the resend happens at most once: a second failure propagates", async () => {
    const s = scriptedSend(5);
    const k = keyRecorder();
    await expect(
      sendWithDialogRecovery("claude-x", s.send, {
        retypeAllowed: true,
        capture: () => INCIDENT_DIALOG,
        sendKeys: k.sendKeys,
        settleMs: 0,
      })
    ).rejects.toThrow(SEND_UNVERIFIED_ERROR);
    expect(s.calls()).toBe(2);
    expect(k.sent).toHaveLength(1);
  });

  test("Journey AC 2: AskUserQuestion → no key at all, DialogBlockedSendError (#423)", async () => {
    const s = scriptedSend(1);
    const k = keyRecorder();
    const err = await sendWithDialogRecovery("claude-x", s.send, {
      retypeAllowed: true,
      capture: () => ASK_DIALOG,
      sendKeys: k.sendKeys,
      settleMs: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialogBlockedSendError);
    expect((err as DialogBlockedSendError).dialog.kind).toBe("ask-user-question");
    expect(k.sent).toEqual([]);
    expect(s.calls()).toBe(1);
  });

  test("an auto-acceptable shape is NOT answered while an /ask was just relayed (#423)", async () => {
    const s = scriptedSend(1);
    const k = keyRecorder();
    const err = await sendWithDialogRecovery("claude-x", s.send, {
      retypeAllowed: true,
      suppressAutoAccept: () => true,
      capture: () => INCIDENT_DIALOG,
      sendKeys: k.sendKeys,
      settleMs: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialogBlockedSendError);
    expect(k.sent).toEqual([]);
    expect(s.calls()).toBe(1);
  });

  test("slash command: the dialog is cleared but the command is not retyped (#429)", async () => {
    const s = scriptedSend(1);
    const k = keyRecorder();
    await expect(
      sendWithDialogRecovery("claude-x", s.send, {
        retypeAllowed: false,
        capture: () => INCIDENT_DIALOG,
        sendKeys: k.sendKeys,
        settleMs: 0,
      })
    ).rejects.toThrow(SEND_UNVERIFIED_ERROR);
    expect(k.sent).toEqual([["C-m"]]);
    expect(s.calls()).toBe(1);
  });

  test("no dialog on screen → the original error, no key", async () => {
    const s = scriptedSend(1);
    const k = keyRecorder();
    const err = await sendWithDialogRecovery("claude-x", s.send, {
      retypeAllowed: true,
      capture: () => "❯ \n  ? for shortcuts",
      sendKeys: k.sendKeys,
      settleMs: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DialogBlockedSendError);
    expect(k.sent).toEqual([]);
  });

  test("capture-pane failure → the original error, no key", async () => {
    const s = scriptedSend(1);
    const k = keyRecorder();
    await expect(
      sendWithDialogRecovery("claude-x", s.send, {
        retypeAllowed: true,
        capture: () => {
          throw new Error("ETIMEDOUT");
        },
        sendKeys: k.sendKeys,
        settleMs: 0,
      })
    ).rejects.toThrow(SEND_UNVERIFIED_ERROR);
    expect(k.sent).toEqual([]);
  });

  test("a non-verification failure (tmux error) never triggers the dialog check", async () => {
    let captured = false;
    const send = async (): Promise<SendOutcome> => {
      throw new Error("can't find session: claude-x");
    };
    await expect(
      sendWithDialogRecovery("claude-x", send, {
        retypeAllowed: true,
        capture: () => {
          captured = true;
          return INCIDENT_DIALOG;
        },
        sendKeys: () => {},
        settleMs: 0,
      })
    ).rejects.toThrow("can't find session");
    expect(captured).toBe(false);
  });

  test("Journey AC 3: a healthy send runs once and never looks at the pane", async () => {
    const s = scriptedSend(0);
    let captured = false;
    const outcome = await sendWithDialogRecovery("claude-x", s.send, {
      retypeAllowed: true,
      capture: () => {
        captured = true;
        return "";
      },
      sendKeys: () => {},
    });
    expect(outcome).toEqual(OK);
    expect(s.calls()).toBe(1);
    expect(captured).toBe(false);
  });
});

describe("buildSendFailureResult with a dialog-blocked send (#562)", () => {
  test("names the dialog kind and the tmux attach command", () => {
    const err = new DialogBlockedSendError(
      { kind: "ask-user-question", autoAcceptable: false, line: "3. Type something." },
      "claude-156964779000"
    );
    const result = buildSendFailureResult(err);
    expect(result.sendFailed).toBe(true);
    expect(result.error).toContain(SEND_UNVERIFIED_ERROR);
    const chunk = result.chunks[0]!;
    expect(chunk).toContain("AskUserQuestion");
    expect(chunk).toContain("attach -t claude-156964779000");
    expect(chunk).toContain("自動では選びません");
    expect(chunk).not.toBe(SEND_FAILURE_USER_MESSAGE);
  });

  test("other manual-only kinds are named, and backticks in the line are neutralised", () => {
    const err = new DialogBlockedSendError(
      { kind: "usage-limit", autoAcceptable: false, line: "You've reached `x` limit" },
      "claude-1"
    );
    const chunk = buildSendFailureResult(err).chunks[0]!;
    expect(chunk).toContain("（usage-limit）");
    expect(chunk).toContain("検出行: `You've reached 'x' limit`");
  });
});

// Real tmux: a pane that behaves like the incident's TUI — the dialog swallows
// typed text (no echo) until Enter closes it, after which typed text renders.
const tmuxAvailable = (() => {
  try {
    execFileSync(TMUX_PATH, ["-V"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
})();
const itmux = tmuxAvailable ? test : test.skip;

describe("sendWithDialogRecovery against a real tmux pane (#562)", () => {
  beforeAll(async () => {
    if (tmuxAvailable) await ensureSocketConfigured();
  });

  itmux(
    "Journey AC 1: dialog open before the send → cleared, message rendered and submitted",
    async () => {
      const name = `relay-dialog-562-${process.pid}-${Date.now()}`;
      const dialog = INCIDENT_DIALOG.replace(/'/g, "");
      const script =
        `printf '%s\\n' '${dialog.split("\n").join("' '")}'; ` +
        `stty -echo; IFS= read -r _; stty echo; clear; exec cat`;
      execFileSync(
        TMUX_PATH,
        [...TMUX_ARGS, "new-session", "-d", "-s", name, "-x", "200", "-y", "30", "bash", "-c", script],
        { timeout: 10_000 }
      );
      const capture = () =>
        execFileSync(TMUX_PATH, [...TMUX_ARGS, "capture-pane", "-p", "-t", name], {
          timeout: 10_000,
        }).toString();
      try {
        for (let i = 0; i < 40 && !capture().includes("Esc to cancel"); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const payload = "dialog-562 recovery probe メッセージ";
        const outcome = await sendWithDialogRecovery(
          name,
          () => sendToPane(name, payload, TMUX_ARGS, { verifyBackoffMs: [50, 100, 200] }),
          { retypeAllowed: true }
        );
        expect(outcome.verified).toBe(true);
        const pane = capture();
        expect(pane).not.toContain("Toggle thinking mode");
        expect(pane).toContain(payload);
      } finally {
        try {
          execFileSync(TMUX_PATH, [...TMUX_ARGS, "kill-session", "-t", name], { timeout: 10_000 });
        } catch {
          // already gone
        }
      }
    },
    20_000
  );
});
