/**
 * Auto-recovery (self-healing) decisions for high-context child sessions
 * (Issue #206, follow-up to #204's notify-only MVP).
 *
 * #204 surfaces a degraded warning when a session crosses the context-budget
 * bands (yellow/red/critical). This module decides what *automatic* remediation
 * to take on top of that warning:
 *
 *   - red      → auto `/session compact` (the safe, fire-and-forget primitive
 *                already used by #200). Fires at a turn boundary (the Stop-hook
 *                relay completion), so it never interrupts an in-flight turn.
 *   - critical → notify only, for now. The right remedy at critical is a
 *                resume-backed *restart*, but auto-restart needs new-thread
 *                orchestration and carries the RW-047 resume-timing risk, so its
 *                EXECUTION is deferred to a focused follow-up. critical keeps the
 *                strong #204 warning (manual `/session resume`).
 *   - any band → a per-session cap bounds how many auto-actions fire, so a
 *                context that rebounds right back above the threshold after a
 *                compact cannot loop forever (RW-043 cap mechanism). When the
 *                cap is hit we stop auto-acting and prompt manual intervention.
 *
 * The planner is a tiny per-session state machine (mirrors the de-dup tracker in
 * context-budget.ts) so it is unit-testable without a live session, and the
 * SessionManager owns the actual side effects (compact / Discord / log).
 */

import type { ContextBudgetLevel } from "./context-budget";

export type SelfHealAction =
  /** Below the auto-action band (yellow): notify only, no remediation. */
  | "none"
  /** Red band: perform an automatic `/session compact`. */
  | "compact"
  /** Critical band: notify only (auto-restart execution deferred to follow-up). */
  | "notify"
  /** Per-session auto-action cap reached: stop auto-acting, prompt manual. */
  | "cap-reached";

export interface SelfHealDecision {
  action: SelfHealAction;
  level: ContextBudgetLevel;
  /** Cumulative auto-actions this session has taken, AFTER this decision. */
  actionCount: number;
  /** The per-session cap in effect (for logging / user messaging). */
  cap: number;
}

export interface SelfHealOptions {
  /**
   * Max auto-actions per session before falling back to manual (RW-043 cap).
   * Defaults to {@link getSelfHealCap}.
   */
  maxAutoActions?: number;
}

export interface SelfHealer {
  /**
   * Decide the auto-action for a band-crossing signal. Call this ONLY when the
   * context-budget tracker produced a warning (i.e. the session crossed up into
   * `level`), so the de-dup already guarantees one decision per episode.
   */
  decide(level: ContextBudgetLevel): SelfHealDecision;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Per-session auto-action cap. Env-overridable (`CONTEXT_SELF_HEAL_MAX_ACTIONS`)
 * for tuning/tests; default 3 — generous enough for a normally-churning session,
 * low enough that a pathological compact↔rebound loop stops quickly.
 */
export function getSelfHealCap(): number {
  return envInt("CONTEXT_SELF_HEAL_MAX_ACTIONS", 3);
}

export function createSelfHealer(options: SelfHealOptions = {}): SelfHealer {
  const cap = options.maxAutoActions ?? getSelfHealCap();
  let actionCount = 0;

  return {
    decide(level) {
      // yellow: the entry band — recommend, never auto-act (avoids interrupting
      // work for a soft signal).
      if (level === "yellow") {
        return { action: "none", level, actionCount, cap };
      }

      // red/critical both want remediation; enforce the cap first so a context
      // that keeps climbing back can never drive an unbounded action loop.
      if (actionCount >= cap) {
        return { action: "cap-reached", level, actionCount, cap };
      }

      if (level === "red") {
        actionCount += 1;
        return { action: "compact", level, actionCount, cap };
      }

      // critical: auto-restart EXECUTION is deferred (RW-047 + new-thread
      // orchestration). Notify only — and do NOT consume an auto-action, since
      // compact is not the right remedy here and we want the cap to gate actual
      // compacts, not critical notifications.
      return { action: "notify", level, actionCount, cap };
    },
  };
}
