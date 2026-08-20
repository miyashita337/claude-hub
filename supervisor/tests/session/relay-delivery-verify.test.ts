import { test, expect, describe, beforeAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  sendToPane,
  buildDeliveryProbe,
  countProbeOccurrences,
  allowsRetype,
  deliveryNoticeFor,
  DELIVERY_PROBE_MAX_CHARS,
  DELIVERY_MAX_VERIFY_ROUNDS,
  DELIVERY_VERIFY_BACKOFF_MS,
  CAPTURE_PANE_TIMEOUT_MS,
  SEND_UNVERIFIED_ERROR,
  DUPLICATE_INPUT_USER_MESSAGE,
  UNVERIFIED_DELIVERY_USER_MESSAGE,
  type PaneReader,
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

  test("slash commands are never retyped, natural language may be (#429)", () => {
    // Retyping a slash command on a false negative would EXECUTE IT TWICE.
    // #429 narrows the old carve-out from "not verified" to "not retyped":
    // measurement showed the pane DOES render slash text (see allowsRetype).
    expect(allowsRetype("/compact 続きの作業")).toBe(false);
    expect(allowsRetype("  /session compact")).toBe(false);
    expect(allowsRetype("/impl 429")).toBe(false);
    expect(allowsRetype("４１６実装開始")).toBe(true);
    // Only a LEADING slash makes it a command; a slash mid-sentence does not.
    expect(allowsRetype("status? / maybe")).toBe(true);
  });

  test("only unclean verdicts produce a user notice", () => {
    // Verified deliveries must stay silent — a notice on every turn would train
    // the user to ignore the one that matters.
    expect(deliveryNoticeFor("verified")).toBeNull();
    expect(deliveryNoticeFor("verified-retyped")).toBeNull();
    expect(deliveryNoticeFor("skipped-no-probe")).toBeNull();
    expect(deliveryNoticeFor("duplicate")).toBe(DUPLICATE_INPUT_USER_MESSAGE);
    expect(deliveryNoticeFor("unverified-observer")).toBe(
      UNVERIFIED_DELIVERY_USER_MESSAGE
    );
  });

  test("notices carry no tmux internals and say what the user should do", () => {
    for (const msg of [
      DUPLICATE_INPUT_USER_MESSAGE,
      UNVERIFIED_DELIVERY_USER_MESSAGE,
    ]) {
      expect(msg).not.toMatch(/send-keys|capture-pane|not in a mode/i);
      // Actionable: every notice ends in something the user can actually do.
      expect(msg).toMatch(/再送|送り直/);
    }
  });

  test("capture timeout leaves room for the whole poll budget", () => {
    // If the reader gave up sooner than the polls run, the verification would
    // report "observer unavailable" on a merely slow — but alive — tmux server.
    const budget = DELIVERY_VERIFY_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(CAPTURE_PANE_TIMEOUT_MS).toBeGreaterThan(budget);
  });

  test("shipped poll schedule stays slow enough for a loaded box", () => {
    // The incident ran at load1≈22-46 on a 10-core machine (supervisor.stderr
    // .log). A schedule that gives up in a few hundred ms would retype into a
    // pane that was merely slow, so keep a >=1s tail and a fast first poll.
    expect(DELIVERY_VERIFY_BACKOFF_MS.length).toBeGreaterThanOrEqual(4);
    expect(DELIVERY_VERIFY_BACKOFF_MS[0]).toBeLessThanOrEqual(100);
    const total = DELIVERY_VERIFY_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1000);
    expect(DELIVERY_MAX_VERIFY_ROUNDS).toBeGreaterThanOrEqual(2);
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
    "#429 AC-2: a slash command the pane never renders is reported, not silent",
    async () => {
      // Before #429 this exact call resolved with `skipped-slash` and the
      // dispatch reported success — the silent stall corp kept hitting. The
      // pane is observed now; only the retype is withheld.
      const name = makeSessionName("slash-drop");
      const dir = mkdtempSync(join(tmpdir(), "relay429-slash-"));
      startDropPane(name, dir); // never renders
      try {
        await waitForOpenMarker(name);
        const typedAttempts: number[] = [];
        await expect(
          sendToPane(name, "/impl 429", TMUX_ARGS, {
            verifyBackoffMs: FAST_BACKOFF,
            onAttemptTyped: (n) => void typedAttempts.push(n),
          })
        ).rejects.toThrow(SEND_UNVERIFIED_ERROR);

        // THE point of #429: typed exactly once. A second type here would be a
        // second `/impl 429` execution the moment the pane recovers.
        expect(typedAttempts).toEqual([1]);
        expect(capturePane(name)).not.toContain("/impl 429");
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  itmux(
    "#429 AC-1: a slash command a healthy pane renders is verified, typed once",
    async () => {
      const name = makeSessionName("slash-ok");
      startEchoPane(name);
      try {
        const payload = "/impl 429";
        const typedAttempts: number[] = [];
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          onAttemptTyped: (n) => void typedAttempts.push(n),
        });
        // Observed, so it may honestly be called verified (unlike the old
        // `skipped-slash`, which was verified:false by construction).
        expect(outcome.verdict).toBe("verified");
        expect(outcome.verified).toBe(true);
        expect(typedAttempts).toEqual([1]);
        // AC-1's "no double input": exactly one copy in the pane.
        expect(countProbeOccurrences(capturePane(name), buildDeliveryProbe(payload))).toBe(1);
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "#429: a pane that recovers mid-flight is still typed into exactly once",
    async () => {
      // PR #434 review, nit-3: this case cannot pin a verdict. Whether the
      // recovered pane renders inside the remaining watch budget is a race with
      // the real tty, so asserting "verified" here would be flaky. The verdict
      // for the late-render path is pinned deterministically by the scripted
      // reader below ("text that shows up only in a LATER round").
      //
      // What this case CAN pin, against a real tmux, is the invariant that
      // matters for a slash command: no matter how the race lands, the literal
      // is put on the wire once. A regression that reinstates the retype fails
      // here even when the timing goes the other way.
      const name = makeSessionName("slash-recover");
      const dir = mkdtempSync(join(tmpdir(), "relay429-recover-"));
      const flag = join(dir, "reopen");
      startDropPane(name, dir, flag);
      try {
        await waitForOpenMarker(name);
        const typedAttempts: number[] = [];
        const outcome = await sendToPane(name, "/session compact", TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          onAttemptTyped: (n) => {
            typedAttempts.push(n);
            // Reopen echo the instant the (swallowed) first type is done, so
            // the recovery happens during the WATCH rounds, not before them.
            if (n === 1) writeFileSync(flag, "");
          },
        }).catch((err) => err as Error);

        expect(typedAttempts).toEqual([1]);
        // Never a retype verdict, because no retype happened — whichever way
        // the race resolved.
        if (!(outcome instanceof Error)) {
          expect(outcome.verdict).not.toBe("verified-retyped");
          expect(outcome.verdict).not.toBe("duplicate");
        }
      } finally {
        killSession(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );
});

/**
 * The branches below are decided entirely by what the pane reader returns, so
 * they are driven through the injected reader instead of by racing a real tmux
 * server (PR #428 review, should-3 / should-4 / should-2). `tmuxSend` still runs
 * against a real pane — only the *observation* is scripted, so the send sequence
 * under test is the production one.
 */
function scriptedReader(frames: readonly (string | null)[]): PaneReader {
  let i = 0;
  return async () => {
    // Past the end, keep returning the last frame: the number of polls that run
    // depends on timing, and the test should assert on the verdict, not on an
    // exact call count.
    const frame = i < frames.length ? frames[i] : frames[frames.length - 1];
    i++;
    return frame ?? null;
  };
}

describe("delivery verification edge cases via an injected pane reader (#422)", () => {
  const payload = "状況報告。";
  const probe = buildDeliveryProbe(payload);

  itmux(
    "a reader that fails before typing yields 'unverified-observer', not a failure",
    async () => {
      const name = makeSessionName("obs-pre");
      startEchoPane(name);
      try {
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          capturePane: scriptedReader([null]),
        });
        // A broken observer must never manufacture a delivery failure...
        expect(outcome.verdict).toBe("unverified-observer");
        // ...and must never be reported as a confirmed delivery either.
        expect(outcome.verified).toBe(false);
        // The message is still typed: falling back to pre-#422 behaviour beats
        // refusing to send because the observer is down.
        expect(capturePane(name)).toContain(payload);
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "a reader that fails mid-flight yields 'unverified-observer'",
    async () => {
      const name = makeSessionName("obs-mid");
      startEchoPane(name);
      try {
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          // baseline OK, then the reader dies on the first poll.
          capturePane: scriptedReader(["", null]),
        });
        expect(outcome.verdict).toBe("unverified-observer");
        expect(outcome.verified).toBe(false);
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "should-3: a baseline occurrence scrolling out does not force a retype",
    async () => {
      const name = makeSessionName("scroll");
      startEchoPane(name);
      try {
        const attempts: number[] = [];
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          onAttemptTyped: (n) => void attempts.push(n),
          capturePane: scriptedReader([
            probe, //          baseline: an earlier turn's copy is on screen (1)
            "", //             poll 1: it scrolled off the visible pane (0)
            probe, //          poll 2: our input rendered (1)
          ]),
        });
        // Against a fixed baseline of 1 this would read as "count never rose"
        // and retype — producing the very duplicate this review flagged.
        expect(outcome.verdict).toBe("verified");
        expect(attempts).toEqual([1]);
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "should-2: both types rendering is reported as 'duplicate', not silent success",
    async () => {
      const name = makeSessionName("dup");
      startEchoPane(name);
      try {
        const attempts: number[] = [];
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          onAttemptTyped: (n) => void attempts.push(n),
          capturePane: scriptedReader([
            "", //                        baseline: nothing on screen (0)
            "", "", "", "", //            attempt 1 polls: never renders (0)
            `${probe} ${probe}`, //       after the retype BOTH renders land (2)
          ]),
        });
        expect(attempts).toEqual([1, 2]);
        expect(outcome.verdict).toBe("duplicate");
        // Still delivered — the text IS in the pane, so this is not a failure...
        expect(outcome.verified).toBe(true);
        // ...but the user is told, which is the point.
        expect(deliveryNoticeFor(outcome.verdict)).toBe(DUPLICATE_INPUT_USER_MESSAGE);
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "a single rise after a retype is 'verified-retyped', not 'duplicate'",
    async () => {
      const name = makeSessionName("retype");
      startEchoPane(name);
      try {
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          capturePane: scriptedReader([
            "", //             baseline (0)
            "", "", "", "", // attempt 1 polls: lost (0)
            probe, //          retype lands once (1)
          ]),
        });
        expect(outcome.verdict).toBe("verified-retyped");
        expect(outcome.verified).toBe(true);
        expect(deliveryNoticeFor(outcome.verdict)).toBeNull();
      } finally {
        killSession(name);
      }
    },
    30_000
  );
});

/**
 * Issue #429 — the no-retype path, driven through the scripted reader so the
 * round structure is pinned deterministically rather than raced against a real
 * TUI. These are the cases that separate "verify but never retype" from both of
 * its neighbours: the old skip (silent) and the retype path (double execution).
 */
describe("slash delivery: verified, never retyped (#429)", () => {
  const slash = "/impl 429";
  const slashProbe = buildDeliveryProbe(slash);

  itmux(
    "text that shows up only in a LATER round is verified, still typed once",
    async () => {
      const name = makeSessionName("slash-round2");
      startEchoPane(name);
      try {
        const typedAttempts: number[] = [];
        const outcome = await sendToPane(name, slash, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          onAttemptTyped: (n) => void typedAttempts.push(n),
          capturePane: scriptedReader([
            "", //                        baseline (0)
            "", "", "", "", //            round 1 polls: nothing yet (0)
            slashProbe, //                round 2: the late render lands (1)
          ]),
        });
        // Round 2 ran (that is the patience this path keeps) but did NOT type.
        expect(typedAttempts).toEqual([1]);
        // Typed once → "verified", never "verified-retyped": the verdict has to
        // describe what we actually did to the pane.
        expect(outcome.verdict).toBe("verified");
        expect(outcome.verified).toBe(true);
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "a rise of 2 without a retype is not blamed on us as 'duplicate'",
    async () => {
      const name = makeSessionName("slash-rise2");
      startEchoPane(name);
      try {
        const outcome = await sendToPane(name, slash, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          capturePane: scriptedReader([
            "", //                                   baseline (0)
            `${slashProbe} ${slashProbe}`, //        two copies appear (2)
          ]),
        });
        // We typed once, so a second copy is the user's own (or an echo the TUI
        // renders twice) — calling it `duplicate` would put a "your input was
        // doubled" warning on a send that behaved perfectly.
        expect(outcome.verdict).toBe("verified");
        expect(deliveryNoticeFor(outcome.verdict)).toBeNull();
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "provably absent through every round → throws, having typed exactly once",
    async () => {
      const name = makeSessionName("slash-never");
      startEchoPane(name);
      try {
        const typedAttempts: number[] = [];
        await expect(
          sendToPane(name, slash, TMUX_ARGS, {
            verifyBackoffMs: FAST_BACKOFF,
            onAttemptTyped: (n) => void typedAttempts.push(n),
            capturePane: scriptedReader([""]), // never renders, ever
          })
        ).rejects.toThrow(SEND_UNVERIFIED_ERROR);
        expect(typedAttempts).toEqual([1]);
      } finally {
        killSession(name);
      }
    },
    30_000
  );

  itmux(
    "natural language keeps its retype — #429 must not disarm #422's recovery",
    async () => {
      const name = makeSessionName("nl-retype");
      startEchoPane(name);
      try {
        const payload = "状況報告。";
        const probe = buildDeliveryProbe(payload);
        const typedAttempts: number[] = [];
        const outcome = await sendToPane(name, payload, TMUX_ARGS, {
          verifyBackoffMs: FAST_BACKOFF,
          onAttemptTyped: (n) => void typedAttempts.push(n),
          capturePane: scriptedReader([
            "", //                        baseline (0)
            "", "", "", "", //            attempt 1 polls: lost (0)
            probe, //                     the retype lands (1)
          ]),
        });
        expect(typedAttempts).toEqual([1, 2]);
        expect(outcome.verdict).toBe("verified-retyped");
      } finally {
        killSession(name);
      }
    },
    30_000
  );
});
