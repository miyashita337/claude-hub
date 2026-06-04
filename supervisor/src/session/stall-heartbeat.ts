/**
 * Stall heartbeat (Issue #12, Journey AC #2).
 *
 * The dialog watchdog ({@link import("./dialog-watchdog").startDialogWatchdog})
 * only fires for *known* dialog families. A truly unknown dialog — anything
 * `detectDialog` does not match — leaves the relay waiting silently until the
 * 5-minute relay timeout, with no notification to the user.
 *
 * This one-shot timer is the final defense: started alongside the watchdog, it
 * fires `fire()` exactly once if the relay has not resolved within `delayMs`
 * (default 3 min). The caller cancels it as soon as a response arrives, so it
 * only fires when the session is genuinely stuck. Keeping it a separate,
 * detection-independent timer means it covers future / unknown dialog families
 * without coupling to Claude Code's churning TUI (RW-027).
 */

// MUST stay below RELAY_TIMEOUT_MS in relay.ts (5 min): the stall heartbeat
// has to fire *while* the relay is still waiting, otherwise the relay times
// out first and the heartbeat never pages.
export const DEFAULT_STALL_DELAY_MS = 3 * 60_000;

export interface StallHeartbeat {
  /** Cancel the pending heartbeat. Idempotent. Safe after it has fired. */
  cancel(): void;
}

/**
 * Schedule a one-shot stall heartbeat. `fire` runs at most once. Errors thrown
 * by `fire` are caught and logged so a paging failure cannot crash the relay.
 */
export function scheduleStallHeartbeat(opts: {
  delayMs?: number;
  fire: () => void | Promise<void>;
}): StallHeartbeat {
  const delayMs = opts.delayMs ?? DEFAULT_STALL_DELAY_MS;
  let fired = false;

  const timer = setTimeout(() => {
    if (fired) return;
    fired = true;
    try {
      const r = opts.fire();
      if (r instanceof Promise) {
        r.catch((err) =>
          console.warn("[StallHeartbeat] fire() rejected:", err)
        );
      }
    } catch (err) {
      console.warn("[StallHeartbeat] fire() threw:", err);
    }
  }, delayMs);

  // Don't keep the event loop alive solely for this timer.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  return {
    cancel(): void {
      fired = true;
      clearTimeout(timer);
    },
  };
}
