import { execFile } from "child_process";
import { promisify } from "util";
import { TMUX_PATH, TMUX_ARGS } from "./tmux";
import {
  detectDialog,
  AUTO_ACCEPT_KEYS,
  type DialogMatch,
} from "./dialog-detect";

/**
 * Dialog detection watchdog.
 *
 * Issue #57: starts a polling loop while a relay is in flight. On each tick
 * it captures the tmux pane, runs {@link detectDialog}, and if a dialog is
 * detected:
 *  1. logs `[Dialog] detected: <kind> line=<line>` (visible in supervisor stdout)
 *  2. attempts auto-accept by sending the kind-specific keys via tmux
 *  3. if the dialog persists across {@link MAX_AUTO_ACCEPT_ATTEMPTS} ticks,
 *     invokes the optional `onHeartbeat` callback so the caller can post a
 *     `ダイアログ検出: <kind>、手動操作要求` message to the Discord thread.
 *
 * The watchdog is intentionally a simple `setInterval`-based poll. Faster /
 * event-driven approaches would require a parser tied to Claude Code's Ink
 * implementation, which churns frequently and would create silent breakage
 * (RW-027 — `pdca-tmux-ready.sh` ready-marker pattern broke after a TUI
 * update). Polling at 5s is a deliberate trade between latency (user gets
 * unstuck within seconds) and tmux server load.
 */

const POLL_INTERVAL_MS = 5_000;
const MAX_AUTO_ACCEPT_ATTEMPTS = 2;
/**
 * Issue #222: ceiling for the per-session exponential backoff applied when
 * `capture-pane` times out. With MAX_SESSIONS watchdogs polling the shared
 * `-L claude-hub` tmux server every 5s, accumulated load pushes capture-pane
 * past its timeout (observed ETIMEDOUT bursts that cascade into relay delay).
 * Backing off a failing session's poll lets the server recover; a successful
 * capture resets it to {@link POLL_INTERVAL_MS}.
 */
const MAX_BACKOFF_MS = 30_000;
/**
 * Issue #222: `capture-pane` timeout. Raised from 2s to 3s so a transient
 * stall on the shared tmux server is not misclassified as a failure on every
 * tick (which would otherwise trigger backoff prematurely).
 */
const CAPTURE_TIMEOUT_MS = 3_000;

/**
 * Issue #227 (PR-2): the watchdog polls every relay-in-flight session every 5s
 * on the shared `-L claude-hub` tmux server. Running capture/send via the
 * *async* `execFile` keeps each poll off the Bun event loop, so N concurrent
 * watchdogs no longer accumulate N synchronous blocks per tick (the dominant
 * starvation source #227 named). `promisify(execFile)` resolves `{ stdout, stderr }`.
 */
const execFileAsync = promisify(execFile);

/**
 * Compute the next poll interval. On a successful capture, reset to `base`;
 * on a failure (e.g. ETIMEDOUT under tmux load), exponentially back off
 * (double) up to `max`. Pure — unit-tested without timers (Issue #222).
 */
export function nextPollInterval(
  current: number,
  base: number,
  max: number,
  capturedOk: boolean
): number {
  if (capturedOk) return base;
  return Math.min(current * 2, max);
}

/**
 * Opaque handle returned by {@link DialogWatchdogOptions.setTimer}. The real
 * implementation returns a `setTimeout` handle; an injected virtual clock
 * returns its own numeric id (Issue #190).
 */
export type WatchdogTimerHandle = ReturnType<typeof setTimeout> | number;

export interface DialogWatchdogOptions {
  /** tmux session name (e.g., `claude-<threadId12>`). */
  tmuxSessionName: string;
  /**
   * Called when a dialog has been detected and N consecutive auto-accept
   * attempts have not cleared it. Caller typically posts a heartbeat
   * message to the Discord thread so the user knows manual intervention
   * is required. The watchdog continues polling after a heartbeat fires.
   */
  onHeartbeat?: (match: DialogMatch) => void | Promise<void>;
  /**
   * Called every time the watchdog attempts auto-accept. Useful for tests
   * to assert detection happened without waiting for the heartbeat path.
   */
  onAutoAccept?: (match: DialogMatch) => void;
  /** Override poll interval — tests use 50ms to keep runtime tight. */
  pollIntervalMs?: number;
  /** Override the max backoff ceiling for capture-pane ETIMEDOUT backoff —
   *  tests shrink this to keep runtime tight. Defaults to
   *  {@link MAX_BACKOFF_MS} (Issue #222). */
  maxBackoffMs?: number;
  /** Override max auto-accept attempts — tests can drop to 1 for speed. */
  maxAutoAcceptAttempts?: number;
  /** Inject a custom capture function — tests pass a fake to avoid spawning
   *  tmux. Defaults to {@link captureViaTmux}. May be sync or async: the tick
   *  awaits it, so a sync fake (returning a string) stays compatible while the
   *  production default is now async (Issue #227 PR-2). */
  capture?: (sessionName: string) => string | Promise<string>;
  /** Inject a custom send-keys function — tests pass a recorder to assert
   *  the right keys were sent. Sync or async; the tick awaits it
   *  (Issue #227 PR-2). Defaults to {@link sendKeysViaTmux}. */
  sendKeys?: (sessionName: string, keys: string[]) => void | Promise<void>;
  /**
   * Inject the timer primitives that space out poll ticks. Tests pass a
   * virtual clock to drive ticks in deterministic virtual time, eliminating
   * the wall-clock `setTimeout` waits that made the watchdog tests flaky
   * under CI/dev-machine load (Issue #190). Production omits both and gets
   * real `setTimeout`/`clearTimeout`, so runtime behaviour is unchanged.
   *
   * `setTimer` receives the async tick itself (not a void-wrapped wrapper) so
   * a virtual clock can `await` full tick completion — including the
   * reschedule performed in the tick's `finally` — before the test asserts.
   */
  setTimer?: (
    callback: () => Promise<void>,
    delayMs: number
  ) => WatchdogTimerHandle;
  /** Companion to {@link setTimer}; defaults to `clearTimeout`. */
  clearTimer?: (handle: WatchdogTimerHandle) => void;
}

export interface DialogWatchdog {
  /** Stop polling. Idempotent. */
  stop(): void;
}

async function captureViaTmux(sessionName: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      TMUX_PATH,
      [...TMUX_ARGS, "capture-pane", "-p", "-t", sessionName],
      { timeout: CAPTURE_TIMEOUT_MS }
    );
    return stdout.toString();
  } catch (err) {
    // Pane gone / server stopped: the session ended — return empty so detect
    // returns null and the watchdog stays at its base interval until it is
    // stopped (a dead pane is observed by manager.ts watchTmuxSession).
    // Any OTHER failure (notably ETIMEDOUT while the shared tmux server is
    // overloaded) is re-thrown so the caller can back off this session's
    // poll instead of hammering the slow server every tick (Issue #222).
    const msg = err instanceof Error ? err.message : String(err);
    if (/no server running|can't find session/i.test(msg)) {
      return "";
    }
    throw err;
  }
}

async function sendKeysViaTmux(sessionName: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await execFileAsync(
        TMUX_PATH,
        [...TMUX_ARGS, "send-keys", "-t", sessionName, key],
        { timeout: 2000 }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Dialog] send-keys ${JSON.stringify(key)} failed for ${sessionName}:`,
        msg
      );
      // Don't throw — the next poll tick will retry. If the pane is dead,
      // detection will simply stop matching.
      return;
    }
  }
}

/**
 * Start polling the named tmux pane for dialog text. Returns a handle with
 * `.stop()`; callers MUST call stop() once the relay turn finishes,
 * otherwise the timer leaks across requests.
 */
export function startDialogWatchdog(
  options: DialogWatchdogOptions
): DialogWatchdog {
  // setTimer / clearTimer is a pair: an injected timer can only be cancelled
  // by its injected clearTimer. Supplying just one would let stop() call the
  // default clearTimeout on an injected handle (or vice versa), which silently
  // fails to cancel the poll loop → timer leak / phantom re-execution. Reject
  // the half-injected case fail-fast at construction (Issue #190, CodeRabbit).
  if ((options.setTimer === undefined) !== (options.clearTimer === undefined)) {
    throw new Error(
      "startDialogWatchdog: setTimer and clearTimer must both be provided or both omitted"
    );
  }
  const {
    tmuxSessionName,
    onHeartbeat,
    onAutoAccept,
    pollIntervalMs = POLL_INTERVAL_MS,
    maxBackoffMs = MAX_BACKOFF_MS,
    maxAutoAcceptAttempts = MAX_AUTO_ACCEPT_ATTEMPTS,
    capture = captureViaTmux,
    sendKeys = sendKeysViaTmux,
    setTimer = (cb, ms) => setTimeout(() => void cb(), ms),
    clearTimer = (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  let lastKind: string | null = null;
  let consecutiveAttempts = 0;
  let heartbeatFired = false;
  let stopped = false;
  let timerHandle: WatchdogTimerHandle | null = null;

  // Recursive setTimeout instead of setInterval: each tick is awaited end-to-end
  // before scheduling the next, so a slow `await onHeartbeat(...)` cannot cause
  // overlapping ticks. The outer try/catch also prevents an unhandled
  // PromiseRejection if `capture` / `detectDialog` / `sendKeys` throws
  // (review: gemini-code-assist on PR #143, comment 3179498219).
  let currentInterval = pollIntervalMs;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let capturedOk = true;
    try {
      let pane: string;
      try {
        pane = await capture(tmuxSessionName);
      } catch (err) {
        // capture-pane failed — typically ETIMEDOUT while the shared tmux
        // server is overloaded by many concurrent watchdogs (Issue #222).
        // Skip detection this tick; the finally block backs off this
        // session's poll so we stop hammering the slow server.
        capturedOk = false;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[Dialog] capture-pane failed for ${tmuxSessionName}:`,
          msg
        );
        return;
      }
      const match = detectDialog(pane);

      if (!match) {
        // Pane is clean — reset attempt counter so a future dialog gets a
        // fresh budget rather than inheriting old state.
        lastKind = null;
        consecutiveAttempts = 0;
        heartbeatFired = false;
        return;
      }

      if (match.kind !== lastKind) {
        // New dialog kind detected — reset counter and log once. Repeated
        // detections of the same kind across ticks share a single log line
        // unless the kind changes.
        lastKind = match.kind;
        consecutiveAttempts = 0;
        heartbeatFired = false;
        console.warn(
          `[Dialog] detected on ${tmuxSessionName}: kind=${match.kind} line=${JSON.stringify(match.line)}`
        );
      }

      if (consecutiveAttempts < maxAutoAcceptAttempts) {
        const keys = AUTO_ACCEPT_KEYS[match.kind];
        consecutiveAttempts++;
        console.warn(
          `[Dialog] auto-accepted: ${match.kind} (attempt ${consecutiveAttempts}/${maxAutoAcceptAttempts}) on ${tmuxSessionName}`
        );
        try {
          await sendKeys(tmuxSessionName, keys);
        } catch (err) {
          console.warn(
            `[Dialog] auto-accept send-keys threw for ${tmuxSessionName}:`,
            err
          );
        }
        onAutoAccept?.(match);
        return;
      }

      // Auto-accept budget exhausted — fire heartbeat once per dialog and
      // keep polling (the user may dismiss it manually, after which lastKind
      // resets via the no-match branch).
      if (!heartbeatFired) {
        heartbeatFired = true;
        console.warn(
          `[Dialog] user-action-required: ${match.kind} on ${tmuxSessionName} — heartbeat dispatched`
        );
        if (onHeartbeat) {
          try {
            await onHeartbeat(match);
          } catch (err) {
            console.warn(`[Dialog] onHeartbeat threw:`, err);
          }
        }
      }
    } catch (err) {
      console.error(
        `[Dialog] watchdog tick failed for ${tmuxSessionName}:`,
        err
      );
    } finally {
      if (!stopped) {
        currentInterval = nextPollInterval(
          currentInterval,
          pollIntervalMs,
          maxBackoffMs,
          capturedOk
        );
        timerHandle = setTimer(tick, currentInterval);
      }
    }
  };

  timerHandle = setTimer(tick, currentInterval);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
    },
  };
}
