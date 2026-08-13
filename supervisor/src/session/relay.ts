import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { waitForRelay, hasRecentAsk, type RelayResult } from "./relay-server";
import { persistAttachments } from "./attachment-store";
import { TMUX_PATH, TMUX_ARGS } from "./tmux";
import { createLatencyTracker } from "./latency-logger";
import { startDialogWatchdog } from "./dialog-watchdog";
import { scheduleStallHeartbeat, DEFAULT_STALL_DELAY_MS } from "./stall-heartbeat";
import { createPageOnce } from "./dialog-stuck-handler";
import type { DialogStuckInfo } from "./dialog-stuck-handler";
import { ATTACHMENT_DIR } from "./gc-attachments";

/**
 * Issue #227 (PR-1): the relay send hot path runs tmux via the *async*
 * `execFile` so a stalled tmux server cannot freeze the Bun single event loop.
 * The previous synchronous exec blocked the whole Supervisor for up to the
 * per-call timeout on every send; under the dialog-watchdog's 5s poll (#222)
 * those blocks accumulated. `promisify(execFile)` resolves to `{ stdout, stderr }`.
 */
const execFileAsync = promisify(execFile);

/**
 * How long to wait for the Claude Code Stop hook to POST the response (ms).
 *
 * Issue #255: the old fixed 5-min ceiling was *shorter* than a normal dispatch
 * agent turn (multi-`bash`/`gh` research easily runs 10-20 min). The relay then
 * gave up on a *live* session and surfaced a false "応答がタイムアウト", even
 * though the Stop hook eventually POSTs and the late-response path forwards it.
 * The default is raised and made tunable via the `RELAY_TIMEOUT_MS` env (ms).
 *
 * Invariant: the effective timeout MUST stay strictly above
 * {@link DEFAULT_STALL_DELAY_MS} so the 3-min stall heartbeat still fires
 * *while* the relay is waiting (it pages the user that a long turn is in
 * progress). {@link RELAY_TIMEOUT_FLOOR_MS} enforces this in code, replacing the
 * comment-only contract that previously lived in stall-heartbeat.ts.
 */
export const DEFAULT_RELAY_TIMEOUT_MS = 15 * 60_000;
/** Lowest effective relay timeout: keeps the stall heartbeat strictly earlier. */
export const RELAY_TIMEOUT_FLOOR_MS = DEFAULT_STALL_DELAY_MS + 60_000;
/** Upper bound so a malformed env can't pin a relay for an unbounded time. */
export const RELAY_TIMEOUT_CEILING_MS = 60 * 60_000;

/**
 * Resolve the relay timeout from `env.RELAY_TIMEOUT_MS` (ms), falling back to
 * {@link DEFAULT_RELAY_TIMEOUT_MS} for absent / non-numeric / non-positive
 * values, then clamping into [floor, ceiling]. Pure + exported so a unit test
 * can lock the default, the clamp, and the stall-heartbeat invariant.
 */
export function readRelayTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RELAY_TIMEOUT_MS;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  const value =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RELAY_TIMEOUT_MS;
  return Math.min(RELAY_TIMEOUT_CEILING_MS, Math.max(RELAY_TIMEOUT_FLOOR_MS, value));
}

const RELAY_TIMEOUT_MS = readRelayTimeoutMs();

export interface AttachmentInfo {
  url: string;
  filename: string;
  contentType: string;
}

// Re-export RelayResult for consumers
export type { RelayResult } from "./relay-server";

/**
 * Download a Discord attachment to a local temp file.
 */
async function downloadAttachment(attachment: AttachmentInfo): Promise<string> {
  mkdirSync(ATTACHMENT_DIR, { recursive: true });
  const localPath = resolve(ATTACHMENT_DIR, `${Date.now()}-${attachment.filename}`);

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(localPath, buffer);
  return localPath;
}

/**
 * Run `tmux send-keys -t <sessionName> <args...>` with a short retry budget.
 *
 * tmux can ETIMEDOUT on transient server stalls (observed after a previous
 * relay hit Response timeout — the pane or server ends up briefly busy).
 * We retry once after a 250ms pause so a flaky moment doesn't surface to
 * the user as a `send-keys` failure.
 */
/** Summarize an execFile error without leaking message content from spawnargs. */
function summarizeExecError(err: unknown): {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
} {
  if (err && typeof err === "object") {
    const e = err as NodeJS.ErrnoException & {
      code?: string | number;
      killed?: boolean;
      signal?: string | null;
    };
    return { code: e.code, killed: e.killed, signal: e.signal };
  }
  return {};
}

function getExecStderr(err: unknown): string {
  const e = err as { stderr?: Buffer | string };
  if (!e.stderr) return "";
  return typeof e.stderr === "string" ? e.stderr : e.stderr.toString();
}

/**
 * Detect a tmux call that was aborted by its own `timeout` option, normalising
 * across the sync→async migration (#227). The synchronous exec threw an error
 * with `.code === "ETIMEDOUT"`; the async `execFile` path instead kills the child
 * with `killSignal` (default SIGTERM) and sets `.killed === true` (with
 * `.code` left null). Accept both so `tmuxSend`'s transient-retry behavior
 * (Issue #73 / RW-019) is byte-for-byte identical after the migration.
 */
function isExecTimeout(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as NodeJS.ErrnoException & { killed?: boolean };
    return e.code === "ETIMEDOUT" || e.killed === true;
  }
  return false;
}

/**
 * If the tmux pane is currently in copy-mode (or any other mode), exit it so
 * the subsequent `send-keys -l` reaches the application instead of being
 * consumed as a mode command. Best-effort / fail-open: any error is logged but
 * not thrown — the caller may still attempt send-keys, and a genuinely dead
 * pane will surface a clearer error from the next call.
 *
 * See Issue #73: tmux pane copy-mode stuck → send-keys silent drop + `not in a mode`.
 */
export async function ensurePaneNotInMode(
  sessionName: string,
  // Issue #199 AC1: socket selector. Defaults to the Supervisor's dedicated
  // `-L claude-hub` socket; pass `[]` to target the DEFAULT socket where the
  // claudeHubExit session lives (started by start-hijoguchi.sh with no -L).
  socketArgs: readonly string[] = TMUX_ARGS
): Promise<void> {
  let mode: string;
  try {
    const { stdout } = await execFileAsync(
      TMUX_PATH,
      [...socketArgs, "display-message", "-t", sessionName, "-p", "#{pane_in_mode}"],
      { timeout: 2000 }
    );
    mode = stdout.toString().trim();
  } catch (err) {
    console.warn(
      `[Relay] pane_in_mode check failed for ${sessionName}:`,
      summarizeExecError(err)
    );
    return;
  }
  if (mode !== "1") return;
  console.warn(`[Relay] pane ${sessionName} in copy-mode, cancelling before send-keys`);
  try {
    await execFileAsync(
      TMUX_PATH,
      [...socketArgs, "send-keys", "-t", sessionName, "-X", "cancel"],
      { timeout: 2000 }
    );
  } catch (err) {
    // Pane may have exited mode between check and cancel — safe to ignore.
    console.warn(
      `[Relay] cancel after mode detection failed for ${sessionName}:`,
      summarizeExecError(err)
    );
  }
}

export async function tmuxSend(
  sessionName: string,
  extraArgs: string[],
  // Issue #199 AC1: socket selector (see ensurePaneNotInMode). Defaults to the
  // claude-hub socket; `[]` targets the default socket (claudeHubExit).
  socketArgs: readonly string[] = TMUX_ARGS
): Promise<void> {
  const args = [...socketArgs, "send-keys", "-t", sessionName, ...extraArgs];
  const PER_CALL_TIMEOUT = 7000;
  try {
    await execFileAsync(TMUX_PATH, args, { timeout: PER_CALL_TIMEOUT });
    return;
  } catch (err) {
    const summary = summarizeExecError(err);
    const stderr = getExecStderr(err);
    const isModeErr = /not in a mode/i.test(stderr);
    const isTimeout = isExecTimeout(err);
    if (!isTimeout && !isModeErr) {
      console.error(`[Relay] tmux send-keys failed:`, summary);
      throw err;
    }
    // Transient: tmux briefly stalled (timeout) OR pane was in copy-mode
    // (`not in a mode`). Exit any stuck mode and try once more.
    console.warn(
      `[Relay] tmux send-keys transient error for ${sessionName} (${isModeErr ? "not-in-a-mode" : "timeout"}), recovering...`
    );
    await ensurePaneNotInMode(sessionName, socketArgs);
    await new Promise((r) => setTimeout(r, 250));
    try {
      await execFileAsync(TMUX_PATH, args, { timeout: PER_CALL_TIMEOUT });
    } catch (retryErr) {
      console.error(
        `[Relay] tmux send-keys retry also failed for ${sessionName}:`,
        summarizeExecError(retryErr)
      );
      throw retryErr;
    }
  }
}

/**
 * Flatten every newline (CR / LF, in any combination or run) to a single space
 * so a multi-line message survives `tmux send-keys -l`, which would otherwise
 * submit at the first newline and split/corrupt the input (Issue #210).
 *
 * The regex MUST use single-backslash `\r` / `\n` (the real CR 0x0D / LF 0x0A
 * code points). The earlier `/[\\r\\n]+/` was double-escaped and matched only
 * the literal characters `\`, `r`, `n`, so it never removed actual newlines —
 * multi-line Discord relays were silently dropped while single-line ones worked.
 */
export function flattenForSendKeys(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/**
 * Issue #422: `tmux send-keys` exits 0 whenever the *target pane exists* — it
 * says nothing about the foreground application having consumed the bytes.
 * Measured on 2026-08-13 (`tmux -L wt422test`, pane running `stty -echo; sleep`):
 * `send-keys -l <probe>` → `exit=0`, and `capture-pane -p -S -` grep for the
 * probe → 0 hits. That is byte-for-byte the #422 symptom: the Supervisor logged
 * a successful relay while the message left no trace anywhere in the pane.
 *
 * So delivery has to be *observed*, not inferred from the exit code. After
 * typing the literal we re-read the pane and require the message's own text to
 * appear; anything else (TUI busy right after a turn, raw-mode stdin not being
 * drained, an unrendered modal) surfaces as a send failure instead of silence.
 *
 * The probe is a prefix of the user's own message — deliberately NOT a TUI
 * literal such as "? for shortcuts". Matching on TUI chrome breaks on every
 * Claude Code redesign (RW-027 / `thin-scaffolding.md`); the user's text does not.
 */
export const DELIVERY_PROBE_MAX_CHARS = 16;

/**
 * Wait schedule between "typed the literal" and "give up on this attempt".
 * Front-loaded so a healthy pane costs ~80ms, with a long tail because the
 * incident happened under load1≈22-46 on a 10-core box (observed in
 * supervisor.stderr.log around the #422 timestamps) where the Ink TUI needs
 * far longer than usual to render a keystroke.
 */
export const DELIVERY_VERIFY_BACKOFF_MS: readonly number[] = [
  80, 150, 250, 400, 600, 800,
];

/**
 * How many verification rounds run before the send is declared undelivered.
 *
 * For retypable text (natural language) a round == a type attempt, so 2 means
 * "one retype after a confirmed non-render". Bounded on purpose: a retype is
 * only safe because the pane was re-read and the text was provably absent, and
 * each extra attempt widens the window where a late render turns into
 * duplicated input.
 *
 * Issue #429: for text that must NOT be retyped (slash commands) the literal is
 * typed in round 1 only and the later rounds just keep watching. The constant is
 * therefore a PATIENCE budget first and a type limit second — that way the
 * no-retype path waits exactly as long before crying failure (~2× the backoff
 * schedule) as the retype path does, instead of being half as tolerant.
 */
export const DELIVERY_MAX_TYPE_ATTEMPTS = 2;

/**
 * `RelayResult.error` marker for a send that tmux accepted but the pane never
 * showed. Kept free of tmux internals so it stays safe in logs, and distinct
 * from a thrown `send-keys` error so the two are greppable apart.
 */
export const SEND_UNVERIFIED_ERROR =
  "send-keys was accepted but the text never appeared in the pane (#422)";

/**
 * How the send ended, from the pane's point of view. Every value except
 * `"verified"` / `"verified-retyped"` means the text was NOT observed, so the
 * caller must not report it as a confirmed delivery (PR #428 review, should-1:
 * a single `delivered` log line covered five different situations, and the next
 * incident is diagnosed from exactly that line).
 */
export type DeliveryVerdict =
  /** The text appeared after the (only) first type. */
  | "verified"
  /** The text appeared only after a retype — the first keystrokes were lost. */
  | "verified-retyped"
  /**
   * The text appeared, but the count rose by 2 — the delayed first type AND the
   * retype both rendered, so the pane now holds the message twice.
   */
  | "duplicate"
  /** Whitespace-only message: no probe to look for. */
  | "skipped-no-probe"
  /** `capture-pane` was unusable, so delivery could not be judged either way. */
  | "unverified-observer";

export interface SendOutcome {
  verdict: DeliveryVerdict;
  /** True only when the text was actually observed in the pane. */
  verified: boolean;
}

/** Verdicts that mean "the pane was observed to hold the text". */
function isVerified(verdict: DeliveryVerdict): boolean {
  return (
    verdict === "verified" ||
    verdict === "verified-retyped" ||
    verdict === "duplicate"
  );
}

/**
 * `capture-pane` timeout. Deliberately above the whole poll budget
 * (sum of {@link DELIVERY_VERIFY_BACKOFF_MS} = 2.28s) so a slow-but-alive tmux
 * server is waited out rather than reported as an observer failure.
 *
 * PR #428 review (should-5) is right that the very condition this guard exists
 * for — load1≈22-46 — is also when tmux itself can be slow, and a timeout here
 * silently degrades back to pre-#422 behaviour. The answer is NOT a bigger
 * guessed number (measured: `capture-pane` ≈190ms at load1≈31, 20 calls in
 * 3.79s — 3s is ~15× that): it is that an observer failure now yields
 * `"unverified-observer"`, which is logged distinctly and surfaced to the user
 * instead of passing as a delivery.
 */
export const CAPTURE_PANE_TIMEOUT_MS = 3000;

/**
 * Whitespace-stripped prefix of the message, used as the delivery probe.
 *
 * Trade-off (PR #428 review, nit-1): stripping whitespace on both sides makes
 * `"a b c"` and `"abc"` compare equal, so the match is slightly LOOSER than the
 * real text. That direction is chosen on purpose — a loose match can only cause
 * a false "delivered" (fail-open, i.e. the pre-#422 behaviour), whereas a strict
 * match would break on every soft-wrapped input row and cause retypes.
 *
 * Whitespace is removed from BOTH sides of the comparison so a soft-wrapped
 * input line (the TUI breaks long input across rows) still matches: the row
 * break is whitespace in `capture-pane` output and disappears on both sides.
 * `Array.from` splits by code point so a surrogate pair is never cut in half.
 */
export function buildDeliveryProbe(text: string): string {
  return Array.from(text.replace(/\s+/g, ""))
    .slice(0, DELIVERY_PROBE_MAX_CHARS)
    .join("");
}

/**
 * Count non-overlapping probe hits in a pane capture (whitespace-insensitive,
 * see {@link buildDeliveryProbe}). Plain `indexOf`, never a RegExp: the probe is
 * user text and would otherwise need escaping.
 */
export function countProbeOccurrences(pane: string, probe: string): number {
  if (!probe) return 0;
  const hay = pane.replace(/\s+/g, "");
  let count = 0;
  let from = 0;
  for (;;) {
    const hit = hay.indexOf(probe, from);
    if (hit < 0) return count;
    count++;
    from = hit + probe.length;
  }
}

/**
 * Whether a literal that provably did not render may be typed a SECOND time.
 *
 * Slash commands may not: a retype that races a late first render leaves
 * `/impl 429` in the pane twice, and the Enter that follows would run the
 * command twice. For natural language a doubled prompt is merely noisy (#428
 * already reports it as `"duplicate"`), so the retype recovery stays on.
 *
 * MEASURED 2026-08-13 (#429) — this replaces the hypothesis PR #428 flagged as
 * unverified in its q-1 note. Driving a real Claude Code TUI (v2.1.229) over an
 * isolated `tmux -L wt429test` socket:
 *
 *     send-keys -t probe -l '/impl 429'   → exit=0
 *     capture-pane -p -t probe            → row 15 reads `❯ /impl 429`
 *     countProbeOccurrences(pane, probe)  → 0 before, 1 after
 *
 * and with the command picker OPEN (a bare `/pd`) the menu overlays the rows
 * *below* the prompt while the input row itself stays on screen and matchable.
 * So the premise for skipping verification — "the picker re-renders the input
 * row, so the text is not matchable" — is false: slash text IS observable.
 *
 * Only the *retype* was ever unsafe. Hence the split this function encodes:
 * verify everything, retype only what is safe to retype. That closes the silent
 * drop on the dispatch injection path (`/impl` / `/pdca`, Issue #429) at zero
 * double-execution risk, which is exactly the shape #428's q-1 note asked for
 * once the measurement existed.
 */
export function allowsRetype(text: string): boolean {
  return !text.trimStart().startsWith("/");
}

/**
 * Read the visible pane. Returns `null` when tmux itself could not be queried,
 * which the caller treats as "inconclusive" rather than "not delivered" — a
 * broken observer must not manufacture a delivery failure (and must not trigger
 * a retype).
 */
export type PaneReader = (
  sessionName: string,
  socketArgs: readonly string[]
) => Promise<string | null>;

const capturePaneText: PaneReader = async (sessionName, socketArgs) => {
  try {
    const { stdout } = await execFileAsync(
      TMUX_PATH,
      [...socketArgs, "capture-pane", "-p", "-t", sessionName],
      { timeout: CAPTURE_PANE_TIMEOUT_MS }
    );
    return stdout.toString();
  } catch (err) {
    console.warn(
      `[Relay] capture-pane failed for ${sessionName} — delivery cannot be verified ` +
        `(falling back to pre-#422 behaviour for this send):`,
      summarizeExecError(err)
    );
    return null;
  }
};

export interface SendToPaneOptions {
  /** Override the poll schedule (tests only; production uses the default). */
  verifyBackoffMs?: readonly number[];
  /**
   * Test seam, never set in production: called right after each literal is
   * typed, with the 1-based attempt number.
   *
   * The #422 regression test has to guarantee that attempt #1 lands while the
   * pane is still swallowing input. Timing that with a wall-clock sleep makes
   * the case silently degrade into a healthy-pane test on a loaded machine (a
   * green test that proves nothing), so the drop window is closed from this
   * hook instead — the same injected-seam approach the dialog watchdog uses for
   * its clock (#190).
   */
  onAttemptTyped?: (attempt: number) => void | Promise<void>;
  /**
   * Test seam, never set in production: replaces the `capture-pane` reader.
   *
   * The two "observer unavailable" early-returns are the safety valve that stops
   * a broken observer from manufacturing a delivery failure, but they were not
   * pinned by any test (PR #428 review, should-4). Injecting the reader lets a
   * test drive `null` (capture failed) and scripted pane contents (scroll-out,
   * double render) deterministically, without racing a real tmux server.
   */
  capturePane?: PaneReader;
}

/**
 * Type one line into the pane and submit it, without waiting for any relay
 * response. This is the shared send sequence used by {@link relayMessage}
 * (which then waits for the Stop-hook POST) and by fire-and-forget sends such
 * as `/session compact` (Issue #200), where the TUI built-in does NOT POST a
 * Stop-hook response — waiting would just burn RELAY_TIMEOUT_MS.
 *
 * Steps (mirrors what relayMessage has always relied on):
 *   1. Exit any stuck tmux mode (copy-mode) so keys reach the app, not the
 *      mode handler (Issue #73 — silent drop / `not in a mode`).
 *   2. Escape to clear Ink TUI modal state (error/confirmation dialogs) that
 *      would otherwise swallow the input (#33).
 *   3. `send-keys -l <literal>` — argv-based, no shell, so backticks/$/quotes
 *      can't corrupt long input.
 *   4. Issue #422: re-read the pane until the text shows up, retyping once if
 *      it provably did not. Throws {@link SEND_UNVERIFIED_ERROR} rather than
 *      returning, so the caller reports a failure instead of waiting out the
 *      relay timeout on a message the TUI never saw. Issue #429: slash commands
 *      go through the same check but are never retyped ({@link allowsRetype}),
 *      so the dispatch injection (`/impl <N>`) is no longer exempt from step 4.
 *   5. A brief pause, then `C-m` (Enter) as a separate call — the Ink TUI can
 *      drop an Enter sent in the same call as a long literal (#32). Enter is
 *      sent only once the text is confirmed present, so a failed send can never
 *      submit a half-typed or empty prompt.
 *
 * Newlines are flattened to spaces because `send-keys -l` would submit at the
 * first newline.
 */
export async function sendToPane(
  tmuxSessionName: string,
  text: string,
  // Issue #199 AC1: socket selector. Defaults to the Supervisor's `-L
  // claude-hub` socket; pass `[]` to reach the claudeHubExit session on the
  // default socket. The send sequence (mode-exit/Escape/-l/C-m) is identical on
  // either socket, so this stays the single source of truth (no dead copy).
  socketArgs: readonly string[] = TMUX_ARGS,
  options?: SendToPaneOptions
): Promise<SendOutcome> {
  const literalText = flattenForSendKeys(text);
  await ensurePaneNotInMode(tmuxSessionName, socketArgs);
  await tmuxSend(tmuxSessionName, ["Escape"], socketArgs);
  await new Promise((r) => setTimeout(r, 50));
  const verdict = await typeLiteral(
    tmuxSessionName,
    literalText,
    socketArgs,
    options
  );
  await new Promise((r) => setTimeout(r, 100));
  await tmuxSend(tmuxSessionName, ["C-m"], socketArgs);
  return { verdict, verified: isVerified(verdict) };
}

/**
 * Type the literal and (unless disabled) confirm it rendered. Extracted from
 * {@link sendToPane} so the verification loop stays readable and the unverified
 * path is byte-for-byte the pre-#422 behaviour.
 */
async function typeLiteral(
  tmuxSessionName: string,
  literalText: string,
  socketArgs: readonly string[],
  options?: SendToPaneOptions
): Promise<DeliveryVerdict> {
  const probe = buildDeliveryProbe(literalText);
  // A whitespace-only message has no probe to look for; typing it unverified
  // matches the old behaviour and costs nothing (there is nothing to lose).
  if (!probe) {
    await tmuxSend(tmuxSessionName, ["-l", literalText], socketArgs);
    await options?.onAttemptTyped?.(1);
    return "skipped-no-probe";
  }

  // Issue #429: retypability, not verifiability, is what varies per text. Slash
  // commands are watched like everything else and simply never retyped.
  const retypeAllowed = allowsRetype(literalText);
  const backoff = options?.verifyBackoffMs ?? DELIVERY_VERIFY_BACKOFF_MS;
  const readPane = options?.capturePane ?? capturePaneText;
  const before = await readPane(tmuxSessionName, socketArgs);
  if (before === null) {
    // Observer broken before we even typed → judge nothing, but still type so
    // the message has its normal chance of landing.
    await tmuxSend(tmuxSessionName, ["-l", literalText], socketArgs);
    await options?.onAttemptTyped?.(1);
    return "unverified-observer";
  }
  // Baseline, not mere presence: the same short text ("状況報告。") may already
  // be on screen from an earlier turn, so delivery means the count went UP.
  //
  // The baseline is a FLOOR, not a constant (PR #428 review, should-3): the
  // pane capture covers only the visible screen, so a pre-existing occurrence
  // can scroll off while we wait. Without this, that scroll-out would look like
  // "count did not rise" → a false negative → an unnecessary retype (i.e. the
  // duplicate this same review flags). Tracking the minimum seen count absorbs
  // it. The residual risk is a false "delivered" (fail-open = pre-#422
  // behaviour), never a false failure.
  let floor = countProbeOccurrences(before, probe);
  // How many times the literal actually went to the pane. Drives the verdict
  // (and the duplicate check), which `round` no longer can: on the no-retype
  // path a later round means "still watching", not "typed again".
  let typed = 0;

  for (let round = 1; round <= DELIVERY_MAX_TYPE_ATTEMPTS; round++) {
    if (round === 1 || retypeAllowed) {
      await tmuxSend(tmuxSessionName, ["-l", literalText], socketArgs);
      typed++;
      await options?.onAttemptTyped?.(typed);
    }

    for (const waitMs of backoff) {
      await new Promise((r) => setTimeout(r, waitMs));
      const after = await readPane(tmuxSessionName, socketArgs);
      if (after === null) return "unverified-observer"; // broke mid-flight
      const count = countProbeOccurrences(after, probe);
      if (count > floor) {
        // A rise of 2 after a retype means BOTH types rendered: the first one
        // was merely late, not lost, so the pane now holds the message twice.
        // Reported rather than silently submitted — the whole point of #422 is
        // that the relay must not hide what it did to the pane. Gated on
        // `typed > 1` because a rise of 2 without a retype is not something we
        // did: it is the user's own text already on screen, and calling that a
        // duplicate would put a scary notice on a perfectly clean send.
        if (typed > 1 && count - floor >= 2) {
          console.warn(
            `[Relay] duplicate input in pane ${tmuxSessionName}: the delayed first ` +
              `type rendered after the retype (count ${floor}→${count})`
          );
          return "duplicate";
        }
        return typed > 1 ? "verified-retyped" : "verified";
      }
      floor = Math.min(floor, count);
    }
    console.warn(
      `[Relay] typed text never rendered in pane ${tmuxSessionName} ` +
        `(round ${round}/${DELIVERY_MAX_TYPE_ATTEMPTS}, typed ${typed}×, ` +
        `retype ${retypeAllowed ? "allowed" : "withheld (#429)"}, ${literalText.length} chars)`
    );
  }

  // Issue #429: reached on the no-retype path too. The command was typed once
  // and never showed up, so it is NOT delivered — throwing (rather than
  // returning a soft verdict) is what stops the Enter below from submitting a
  // pane we could not read, and what makes the caller report the failure
  // instead of waiting out the relay timeout in silence.
  throw new Error(SEND_UNVERIFIED_ERROR);
}

/**
 * Send a message to Claude Code via tmux send-keys and wait for
 * the response via HTTP relay (Stop hook POST).
 *
 * Issue #57: while waiting for the Stop-hook response, a dialog watchdog
 * polls the pane every 5s. Dialogs that slip past `--dangerously-skip-
 * permissions` (Plan mode confirmation, AskUserQuestion, MCP elicitation,
 * Bash interactive y/n) cause the TUI to stall silently — without
 * detection the relay simply times out at RELAY_TIMEOUT_MS (default 15 min,
 * env-tunable since Issue #255). The
 * watchdog auto-accepts known kinds and, if the dialog persists, fires
 * `onDialogStuck` so the caller can post a heartbeat to Discord.
 */
export interface RelayMessageOptions {
  attachments?: AttachmentInfo[];
  /**
   * Project directory of the session (the claude cwd). When provided,
   * downloaded attachments are also persisted under
   * `<persistDir>/.claude/discord-materials/<threadId>/` and Claude is handed
   * the persistent path instead of the ephemeral tmp path (Issue #152). The
   * tmp copy is still cleaned up after 5 min; the persistent copy survives so
   * "material screenshots" remain readable for the whole task.
   */
  persistDir?: string;
  /**
   * Called when the relay is stuck waiting for the user. Two triggers:
   *  - the dialog watchdog exhausted its auto-accept budget for a *known*
   *    dialog family (`kind` = detected DialogKind), or
   *  - no response arrived within the stall threshold and no known dialog
   *    matched — an *unknown* dialog (`kind: "stall"`).
   * The callback typically posts a heartbeat to the Discord thread and pages
   * Pushover so the user can `tmux attach`. Errors thrown by the callback are
   * caught and logged — they never block the relay. Fired at most once per
   * relay turn.
   */
  onDialogStuck?: (info: DialogStuckInfo) => void | Promise<void>;
}

/**
 * Issue #74: user-facing notice when relaying a message to the tmux pane fails
 * outright (i.e. after the in-call retry in {@link tmuxSend}). The raw failure
 * is typically a copy-mode `not in a mode` or an ETIMEDOUT under tmux load
 * (Issue #73 / RW-019). Previously the catch path interpolated `${err}` — the
 * raw `tmux send-keys ...` command line plus the bare `not in a mode` string —
 * straight into a Discord chunk, so the thread showed bogus "responses" (the
 * #74 screenshot: `not in a mode` posted 5×). This message is deliberately
 * free of tmux internals; the raw cause is preserved in logs + `RelayResult.error`.
 *
 * Issue #236: the original wording pointed at `/session restart`, which is not a
 * real subcommand (`session.ts` registers start/stop/list/status/resume/compact/
 * keep). Recovery guidance now names commands that exist.
 */
export const SEND_FAILURE_USER_MESSAGE =
  "⚠️ メッセージを Claude Code セッションに送信できませんでした（セッションが応答不能、または画面が一時的に固まっている可能性があります）。少し待って再送するか、`/session stop` → `/session start` で再起動してください。";

/**
 * Issue #236 (follow-up of #74): user-facing notice for a failure caught by the
 * relay block's OUTER catch in `bot.ts` — i.e. anything awaited in that block
 * that has no inner catch (the session-teardown race in `sendMessage`, a
 * `bun:sqlite` write, a `thread.send` DiscordAPIError, or any throw a future
 * change adds there).
 *
 * That catch used to interpolate `err.message` (sliced at 1900 chars) straight
 * into the Discord message. Node/Bun `Error.message` embeds absolute paths —
 * `ENOENT: no such file or directory, open '/Users/<name>/...'` — and
 * `String(err)` on a non-Error throwable can carry anything, so the shape
 * itself is the vulnerability: one new fs/child-process throw in that block and
 * a home path is posted to a thread that may have non-owner readers.
 *
 * Same contract as {@link SEND_FAILURE_USER_MESSAGE}: clean + actionable for the
 * user, raw cause preserved in `console.error` for diagnostics.
 */
export const RELAY_ERROR_USER_MESSAGE =
  "⚠️ Claude Code への中継中にエラーが発生しました（一時的な障害の可能性があります）。`/session status` で状態を確認し、少し待ってから再送してください。復旧しない場合は `/session stop` → `/session start` で再起動するか、`/session resume` で会話履歴付きに復帰してください。詳細は Supervisor のログに記録されています。";

/**
 * Issue #422 / PR #428 review (should-2): the delayed first type and the retype
 * both rendered, so Claude is about to read the message twice. The text IS
 * delivered, so the send is not failed — but it is not silent either.
 */
export const DUPLICATE_INPUT_USER_MESSAGE =
  "⚠️ 送信時に入力が二重に入った可能性があります（1 回目の入力が遅れて描画され、再入力と重なりました。#422）。Claude に同じ文が 2 回続けて渡っているかもしれません。応答が不自然なら元の内容で送り直してください。";

/**
 * PR #428 review (should-5): `capture-pane` itself failed, so this send fell
 * back to pre-#422 behaviour — it may have landed, it may have vanished, and
 * the Supervisor cannot tell. Saying so is the whole point; the failure mode
 * this PR exists to kill is exactly "looked fine in the log".
 */
export const UNVERIFIED_DELIVERY_USER_MESSAGE =
  "⚠️ メッセージは送信しましたが、tmux ペインを読み取れなかったため **到達を確認できていません**（高負荷時に起こります。#422）。応答が返らない場合は届いていない可能性があるので、再送してください。";

/**
 * Map a non-clean verdict to the notice the user should see, or null when the
 * delivery was verified and needs no comment. Pure + exported so the wording and
 * the "verified verdicts stay silent" contract are unit-testable.
 */
export function deliveryNoticeFor(verdict: DeliveryVerdict): string | null {
  if (verdict === "duplicate") return DUPLICATE_INPUT_USER_MESSAGE;
  if (verdict === "unverified-observer") return UNVERIFIED_DELIVERY_USER_MESSAGE;
  return null;
}

/**
 * Build the {@link RelayResult} for a send-keys failure. Pure + exported so a
 * unit test can lock that raw tmux internals never reach the user-facing chunk
 * while the diagnostic cause is still carried in `error` (Issue #74). By the
 * time this fires, {@link tmuxSend} has already retried once after exiting any
 * stuck copy-mode (Issue #73 / RW-019), so the failure is non-transient.
 */
export function buildSendFailureResult(err: unknown): RelayResult {
  return {
    text: "",
    chunks: [SEND_FAILURE_USER_MESSAGE],
    error: String(err),
    // Issue #429: `error` alone cannot tell a caller WHICH half failed — a relay
    // timeout sets it too, and there the message *was* delivered (the job is
    // just still running). Dispatch has to separate those: reporting a delivered
    // `/impl` as failed would be as wrong as the silent drop it is fixing.
    sendFailed: true,
  };
}

export async function relayMessage(
  tmuxSessionName: string,
  threadId: string,
  message: string,
  options?: RelayMessageOptions
): Promise<RelayResult> {
  // 1. Download attachments
  const localFiles: string[] = [];
  let fullMessage = message;

  if (options?.attachments?.length) {
    for (const att of options.attachments) {
      try {
        const localPath = await downloadAttachment(att);
        localFiles.push(localPath);
      } catch (err) {
        console.error(`[Relay] Failed to download attachment ${att.filename}:`, err);
      }
    }

    if (localFiles.length > 0) {
      // Issue #152: hand Claude the persistent project-asset paths (when a
      // persistDir is known) so the materials survive past the 5-min tmp
      // cleanup. Falls back to the tmp paths per-file if persistence fails.
      const claudeFiles = options.persistDir
        ? await persistAttachments(localFiles, options.persistDir, threadId)
        : localFiles;
      const imageInstructions = claudeFiles
        .map((f) => `Read the image at ${f}`)
        .join(", and ");
      fullMessage = `${imageInstructions}. ${message}`;
    }
  }

  // Latency tracker: Issue #135 / Epic #101 で高負荷時 70s+ 遅延の dominant
  // segment を特定するために各 segment の所要 ms を記録。session_id には
  // tmux session 名 (= supervisor 内で安定識別子) を使う。
  // 観測機構の失敗は relay 本来の処理を止めない (latency-logger.ts 参照)。
  const tracker = createLatencyTracker(tmuxSessionName);

  // 2. Send via tmux send-keys (mode exit + Escape + send-keys -l + C-m). The
  // full sequence and its rationale (Issue #73 copy-mode, #33 modal clear, #32
  // dropped Enter, argv-no-shell safety) live in sendToPane, shared with the
  // fire-and-forget compact path (Issue #200).
  let outcome: SendOutcome;
  try {
    // Segment (b): tmux 経路
    tracker.markStart("b");
    outcome = await sendToPane(tmuxSessionName, fullMessage);
    tracker.markEnd("b");
  } catch (err) {
    tracker.markEnd("b");
    tracker.setError("b");
    // Issue #223: the message never reached the pane, so this turn delivered
    // nothing to the user — the dropped half of the delivery rate.
    tracker.setDelivered(false);
    tracker.flush();
    // Issue #74: keep the raw tmux cause in logs + `RelayResult.error`, but
    // NEVER forward it into the Discord chunk (it would surface as a bogus
    // `not in a mode` "response"). buildSendFailureResult returns a clean,
    // actionable notice instead.
    //
    // Issue #422: the verification failure is not an execFile error, so
    // summarizeExecError would print an empty `{}` and hide the one case we
    // added the check for. Log its marker verbatim — it carries no tmux
    // internals by construction.
    const isUnverified =
      err instanceof Error && err.message === SEND_UNVERIFIED_ERROR;
    console.error(
      `[Relay] sendToPane failed for ${tmuxSessionName}:`,
      isUnverified ? SEND_UNVERIFIED_ERROR : summarizeExecError(err)
    );
    return buildSendFailureResult(err);
  }
  // Issue #422: the send-side record. `[Bot] Relay start …` is printed before
  // the send even begins, so it could never tell an attempt apart from a
  // delivery. The verdict is carried here because "delivered" alone covered
  // five different situations, only two of which mean the pane was observed
  // (PR #428 review, should-1) — and the next incident is diagnosed from
  // exactly this line.
  console.log(
    `[Relay] send finished for ${tmuxSessionName}: ${outcome.verdict} ` +
      `(pane observed: ${outcome.verified ? "yes" : "no"})`
  );

  // Segment (c): tmux send 完了 → waitForRelay 開始までの隙間 (大体ゼロ、
  // でも明示的に記録しておくことで設計レビュー時の sanity check になる)
  tracker.markStart("c");
  tracker.markEnd("c");

  // 3. Wait for Stop hook to POST the response
  // Segment (d_e_c): claude TUI 受信 + skill/hook init + MCP capability
  // discovery + Anthropic API 呼出 + Stop hook fire の合計。supervisor から
  // は内訳を分離できないため 1 まとめで記録 (Issue #135 で「(d)+(e)+(c)」と
  // して観測する設計と一致)。
  tracker.markStart("d_e_c");

  // Issue #12: page the user at most once per relay turn. Two independent
  // triggers can fire — the watchdog (known dialog, ~10s) and the stall timer
  // (unknown dialog, 3min). For a persistent *known* dialog both would
  // otherwise fire, double-posting to Discord and risking a Pushover
  // rate-limit. `createPageOnce` collapses them to a single page; the first
  // trigger wins (the watchdog reports the precise dialog kind when it can).
  const pageOnce = createPageOnce(options?.onDialogStuck);

  // Issue #57: Start the dialog watchdog *during* the wait. Stops in
  // finally so a thrown error or early return path can never leak the
  // timer handle. The watchdog's DialogMatch is adapted to DialogStuckInfo
  // (adding tmuxSessionName so the heartbeat can tell the user which session
  // to `tmux attach`). If the caller supplied no onDialogStuck we still log
  // to stderr inside the watchdog so the dialog surfaces in supervisor logs.
  const watchdog = startDialogWatchdog({
    tmuxSessionName,
    // Issue #423: the shape detector (`ask-user-question`) is the first line of
    // defence and depends on a TUI literal. This is the second, and depends on
    // nothing rendered: if an AskUserQuestion was relayed for this thread just
    // now, the dialog on screen is the hook's fallback, so no key may be sent
    // no matter which pattern the pane happens to match.
    suppressAutoAccept: () => hasRecentAsk(threadId),
    onHeartbeat: options?.onDialogStuck
      ? (match) =>
          pageOnce({
            kind: match.kind,
            line: match.line,
            tmuxSessionName,
          })
      : undefined,
  });

  // Issue #12 (Journey AC #2): the watchdog only fires for *known* dialog
  // families. An unknown dialog leaves the relay waiting silently. This
  // one-shot stall timer is the final defense — it pages the user once if no
  // response arrives within the stall threshold, then the relay keeps waiting
  // up to RELAY_TIMEOUT_MS. Cancelled in finally as soon as we resolve.
  const stall = scheduleStallHeartbeat({
    fire: () => {
      // Always surface the stall in supervisor logs: when no onDialogStuck
      // handler is registered pageOnce is a silent no-op, so without this the
      // 3-min stall would never appear anywhere observable (gemini #195).
      console.warn(
        `[Relay] session ${tmuxSessionName} stalled: no response within stall threshold`
      );
      return pageOnce({
        kind: "stall",
        line: "no response within stall threshold",
        tmuxSessionName,
      });
    },
  });

  let result: RelayResult;
  try {
    result = await waitForRelay(threadId, RELAY_TIMEOUT_MS);
  } finally {
    watchdog.stop();
    stall.cancel();
  }
  tracker.markEnd("d_e_c");
  if (result.error) {
    tracker.setError("d_e_c");
  }
  // Issue #223: `result.error` covers both the relay timeout and an error
  // response, i.e. exactly the cases where the user got no answer back. Anything
  // else means a response chunk was produced for this turn.
  tracker.setDelivered(!result.error);
  tracker.flush();

  // PR #428 review (should-2 / should-5): a send that was duplicated or could
  // not be observed still produced a response, so it is not a failure — but the
  // user is the only one who can judge a doubled prompt or decide to resend, and
  // they cannot do that from a Supervisor log they never see. Prepend the notice
  // so it arrives with the turn it belongs to.
  const notice = deliveryNoticeFor(outcome.verdict);
  if (notice) {
    result = { ...result, chunks: [notice, ...result.chunks] };
  }

  // Note: downloaded attachments are intentionally NOT deleted here. They used
  // to be unlinked 5 minutes after each relay, which made material screenshots
  // vanish between sessions (Issue #151). They now persist in ATTACHMENT_DIR and
  // are swept only by age via gc-attachments (com.claude-hub.gc-attachments,
  // daily, 30-day retention).
  return result;
}
