import { test, expect, describe, beforeAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  sendToPane,
  buildDeliveryProbe,
  countProbeOccurrences,
  shouldVerifyDelivery,
  DELIVERY_PROBE_MAX_CHARS,
  DELIVERY_MAX_TYPE_ATTEMPTS,
  DELIVERY_VERIFY_BACKOFF_MS,
  SEND_UNVERIFIED_ERROR,
} from "../../src/session/relay";
import { TMUX_ARGS, ensureSocketConfigured } from "../../src/session/tmux";

/**
 * Issue #422: "turn 完了直後の Discord メッセージが中継ログ上は成功なのに TUI に
 * 到達せずサイレント消失する".
 *
 * Measured mechanism (2026-08-13, `tmux -L wt422test`, pane running
 * `bash -c 'stty -echo; sleep 60'`):
 *
 *     tmux send-keys -t <pane> -l SILENT_DROP_PROBE_ABC   → exit=0
 *     tmux capture-pane -p -S - -t <pane> | grep -c PROBE → 0
 *
 * `send-keys` reports success as long as the TARGET PANE EXISTS; whether the
 * foreground application consumed or rendered the bytes is invisible to it. In
 * the incident the Claude Code TUI (raw mode, no terminal echo) never rendered
 * the two messages, so `capture-pane -S -` over the whole session history had
 * zero hits — while the Supervisor had already logged the relay as done.
 *
 * These tests reproduce that class of loss with a pane whose terminal echo is
 * switched OFF for a window the test controls (bytes that arrive during the
 * window are consumed by the tty and never appear), and lock the new contract:
 *
 *   - a drop that recovers  → retyped, delivered, exactly once (AC-1 / AC-3)
 *   - a drop that persists  → throws, so the caller reports it (AC-2)
 *   - a healthy pane        → single attempt, no duplicated input
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

/**
 * Short poll schedule for the tests. The production default
 * ({@link DELIVERY_VERIFY_BACKOFF_MS}) is deliberately slower — it has to
 * tolerate the load1≈22-46 the incident happened under — which would push these
 * cases past a sane test timeout. The default itself is locked by a pure test
 * below, so shrinking it here cannot hide a regression in the shipped value.
 */
const FAST_BACKOFF = [30, 60, 120, 240] as const;

function makeSessionName(tag: string): string {
  return `relay422-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
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

/** Marker the harness prints once terminal echo is OFF (drop window open). */
const OPEN_MARKER = "DROPWINDOW_OPEN";

/**
 * Start a pane that swallows input without a trace, exactly like the TUI did.
 *
 * `stty -echo` is the closest faithful stand-in available without driving a real
 * `claude` TUI: bytes arriving while echo is off are absorbed by the terminal
 * line discipline and never rendered, so `capture-pane` shows nothing — the #422
 * signature. `sleep` (never reading stdin) keeps the pane alive.
 *
 * When `flagPath` is given, echo is restored as soon as the test creates that
 * file, so the recovery moment is controlled by the test rather than by a race
 * against a `sleep` under CI load. `dir` holds the generated script and is the
 * caller's to remove.
 */
function startDropPane(name: string, dir: string, flagPath?: string): void {
  const script = join(dir, "drop-pane.sh");
  const reopen = flagPath
    ? `while [ ! -f ${JSON.stringify(flagPath)} ]; do sleep 0.02; done\nstty echo\n`
    : "";
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -u
stty -echo
printf '${OPEN_MARKER}\\n'
${reopen}sleep 600
`
  );
  chmodSync(script, 0o755);
  execFileSync(
    TMUX_PATH,
    [
      ...TMUX_ARGS,
      "new-session",
      "-d",
      "-s",
      name,
      // Wide pane: long payloads must not soft-wrap in ways that complicate
      // reading the capture by eye when a case fails.
      "-x",
      "500",
      "-y",
      "40",
      "bash",
      script,
    ],
    { timeout: TMUX_OP_TIMEOUT }
  );
}

/** Start a pane that echoes normally (healthy TUI stand-in). */
function startEchoPane(name: string): void {
  execFileSync(
    TMUX_PATH,
    [...TMUX_ARGS, "new-session", "-d", "-s", name, "-x", "500", "-y", "40", "sleep", "600"],
    { timeout: TMUX_OP_TIMEOUT }
  );
}

async function waitForOpenMarker(name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (capturePane(name).includes(OPEN_MARKER)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`drop pane ${name} never reported ${OPEN_MARKER}`);
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

describe("delivery probe helpers (#422)", () => {
  test("probe is a whitespace-stripped, length-capped prefix", () => {
    expect(buildDeliveryProbe("４１６実装開始")).toBe("４１６実装開始");
    expect(buildDeliveryProbe("状況報告。")).toBe("状況報告。");
    // Newlines/spaces are removed so a soft-wrapped input row still matches.
    expect(buildDeliveryProbe("a b\nc")).toBe("abc");
    const long = "0123456789abcdefghijklmnop";
    expect(buildDeliveryProbe(long)).toHaveLength(DELIVERY_PROBE_MAX_CHARS);
    expect(long.startsWith(buildDeliveryProbe(long))).toBe(true);
  });

  test("probe never splits a surrogate pair", () => {
    // 20 astral code points: a naive slice(0,16) on UTF-16 units would cut the
    // 8th emoji in half and produce a needle that can never match.
    const emoji = "🍣".repeat(20);
    const probe = buildDeliveryProbe(emoji);
    expect(Array.from(probe)).toHaveLength(DELIVERY_PROBE_MAX_CHARS);
    expect(emoji.startsWith(probe)).toBe(true);
  });

  test("empty / whitespace-only text yields no probe (verification skipped)", () => {
    expect(buildDeliveryProbe("")).toBe("");
    expect(buildDeliveryProbe("   \n  ")).toBe("");
  });

  test("occurrence count is whitespace-insensitive and counts repeats", () => {
    expect(countProbeOccurrences("❯ ４１６実装開始", "４１６実装開始")).toBe(1);
    // Soft-wrapped across two rows — the row break is whitespace on both sides.
    expect(countProbeOccurrences("❯ ４１６実\n装開始", "４１６実装開始")).toBe(1);
    // The same short phrase already on screen from an earlier turn is why the
    // check compares counts (baseline) instead of mere presence.
    expect(countProbeOccurrences("状況報告。\n❯ 状況報告。", "状況報告。")).toBe(2);
    expect(countProbeOccurrences("nothing here", "状況報告。")).toBe(0);
    expect(countProbeOccurrences("anything", "")).toBe(0);
  });

  test("probe matching uses substring, not regex (user text is not escaped)", () => {
    // A regex-based implementation would throw or mis-match on these.
    expect(countProbeOccurrences("a(b)c+d", "(b)c+d")).toBe(1);
    expect(countProbeOccurrences("a.c", "a.c")).toBe(1);
    expect(countProbeOccurrences("abc", "a.c")).toBe(0);
  });

  test("slash commands skip verification, natural language does not", () => {
    // Retyping a slash command on a false negative would EXECUTE IT TWICE.
    expect(shouldVerifyDelivery("/compact 続きの作業")).toBe(false);
    expect(shouldVerifyDelivery("  /session compact")).toBe(false);
    expect(shouldVerifyDelivery("４１６実装開始")).toBe(true);
    expect(shouldVerifyDelivery("status? / maybe")).toBe(true);
  });

  test("shipped poll schedule stays slow enough for a loaded box", () => {
    // The incident ran at load1≈22-46 on a 10-core machine (supervisor.stderr
    // .log). A schedule that gives up in a few hundred ms would retype into a
    // pane that was merely slow, so keep a >=1s tail and a fast first poll.
    expect(DELIVERY_VERIFY_BACKOFF_MS.length).toBeGreaterThanOrEqual(4);
    expect(DELIVERY_VERIFY_BACKOFF_MS[0]).toBeLessThanOrEqual(100);
    const total = DELIVERY_VERIFY_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1000);
    expect(DELIVERY_MAX_TYPE_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });
});

describe("sendToPane delivery verification against a real pane (#422)", () => {
  itmux(
    "AC-2: input the pane never renders is reported, not silently accepted",
    async () => {
      const name = makeSessionName("drop");
      const dir = mkdtempSync(join(tmpdir(), "relay422-drop-"));
      startDropPane(name, dir); // echo stays off forever
      try {
        await waitForOpenMarker(name);
        const payload = "４１６実装開始";

        // Pre-fix behaviour: this resolved successfully (send-keys exit 0) and
        // the message was lost with no record anywhere.
        await expect(
          sendToPane(name, payload, TMUX_ARGS, { verifyBackoffMs: FAST_BACKOFF })
        ).rejects.toThrow(SEND_UNVERIFIED_ERROR);

        // The pane really never showed it — this is the #422 evidence shape.
        expect(capturePane(name)).not.toContain(payload);
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  itmux(
    "AC-1: a message dropped right after the pane recovers is retyped and lands",
    async () => {
      const name = makeSessionName("recover");
      const dir = mkdtempSync(join(tmpdir(), "relay422-flag-"));
      const flag = join(dir, "reopen");
      startDropPane(name, dir, flag);
      try {
        await waitForOpenMarker(name);
        const payload = "４１６実装開始";
        const attempts: number[] = [];

        // Reopen echo the instant attempt #1 has been typed: those keystrokes
        // are already lost, so only a retype can deliver the message. Driving
        // this from the hook (not a sleep) keeps the case honest on a loaded
        // machine, where a fixed delay would reopen echo BEFORE attempt #1 and
        // silently turn this into a healthy-pane test.
        await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          onAttemptTyped: (attempt) => {
            attempts.push(attempt);
            if (attempt === 1) writeFileSync(flag, "");
          },
        }); // must resolve — delivery was observed
        expect(existsSync(flag)).toBe(true);
        // The recovery path really ran: a first (swallowed) type, then a retype.
        expect(attempts).toEqual([1, 2]);
        const pane = capturePane(name);
        expect(pane).toContain(payload);
        // Retyped exactly once: the swallowed attempt left no visible copy.
        expect(countProbeOccurrences(pane, buildDeliveryProbe(payload))).toBe(1);
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  itmux(
    "a healthy pane is typed into exactly once (no duplicate input)",
    async () => {
      const name = makeSessionName("healthy");
      startEchoPane(name);
      try {
        const payload = "状況報告。ヘルシーな pane では再入力しない";
        await sendToPane(name, payload, TMUX_ARGS, { verifyBackoffMs: FAST_BACKOFF });
        const pane = capturePane(name);
        expect(countProbeOccurrences(pane, buildDeliveryProbe(payload))).toBe(1);
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "AC-3: 10 consecutive drops all recover — zero silent losses",
    async () => {
      const results: boolean[] = [];
      const retyped: number[] = [];
      for (let i = 0; i < 10; i++) {
        const name = makeSessionName(`loop${i}`);
        const dir = mkdtempSync(join(tmpdir(), "relay422-loop-"));
        const flag = join(dir, "reopen");
        startDropPane(name, dir, flag);
        try {
          await waitForOpenMarker(name);
          const payload = `連続テスト${i}回目の作業指示`;
          let attemptCount = 0;
          await sendToPane(name, payload, TMUX_ARGS, {
            verifyBackoffMs: FAST_BACKOFF,
            onAttemptTyped: (attempt) => {
              attemptCount = attempt;
              if (attempt === 1) writeFileSync(flag, "");
            },
          });
          retyped.push(attemptCount);
          results.push(capturePane(name).includes(payload));
        } finally {
          killSession(name);
          rmSync(dir, { recursive: true, force: true });
        }
      }
      // 10/10 delivered ...
      expect(results).toEqual(Array(10).fill(true));
      // ... and every one of them actually went through the recovery path,
      // so a regression that stops retyping cannot pass this case.
      expect(retyped).toEqual(Array(10).fill(2));
    },
    120_000
  );

  itmux(
    "slash commands are sent unverified (a retype would execute them twice)",
    async () => {
      const name = makeSessionName("slash");
      const dir = mkdtempSync(join(tmpdir(), "relay422-slash-"));
      startDropPane(name, dir); // never renders — a verified send would throw here
      try {
        await waitForOpenMarker(name);
        await expect(
          sendToPane(name, "/compact 続きの作業", TMUX_ARGS, {
            verifyBackoffMs: FAST_BACKOFF,
          })
        ).resolves.toBeUndefined();
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );
});
