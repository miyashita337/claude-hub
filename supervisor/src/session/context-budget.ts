/**
 * Context-budget monitoring for child Claude Code sessions (Issue #204).
 *
 * At high context (~330k+ tokens) a session's tool-call markup can degrade to
 * literal text (observed: `court`); the harness then treats it as plain text
 * and the tool silently never runs (context rot). Crucially the session still
 * produces a *text* turn, so the Stop hook fires and the relay resolves
 * "normally" — neither the dialog watchdog nor the stall heartbeat (relay.ts)
 * catches it. The deterministic signal that *precedes* this failure is the
 * context token count, which the Stop hook (`hooks/stop-relay.sh`) computes
 * from the official transcript and forwards on the relay POST.
 *
 * This module classifies that count against the agent-base context-budget
 * thresholds (rules/general/context-budget.md) and builds a degraded warning
 * for the Discord thread.
 *
 * Design (Issue #204 MVP, user decision 2026-06-09): notify-only. We surface
 * the risk and recommend `/session compact`; we do NOT auto-compact/restart
 * (that is a follow-up). Detection is purely numeric — NOT a TUI string match
 * of `court` — so it cannot silently break on a Claude Code TUI update (RW-027).
 */

export type ContextBudgetLevel = "yellow" | "red" | "critical";

export interface ContextBudgetThresholds {
  yellow: number;
  red: number;
  critical: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Thresholds mirror agent-base rules/general/context-budget.md (#70/#71): on a
 * 1M-context model, rot appears from ~300-400k. Env-overridable for tuning and
 * tests. Read at call time (not module load) so tests can set env per-case.
 */
export function getThresholds(): ContextBudgetThresholds {
  return {
    yellow: envInt("CONTEXT_BUDGET_YELLOW", 300_000),
    red: envInt("CONTEXT_BUDGET_RED", 400_000),
    critical: envInt("CONTEXT_BUDGET_CRITICAL", 800_000),
  };
}

const LEVEL_RANK: Record<ContextBudgetLevel, number> = {
  yellow: 1,
  red: 2,
  critical: 3,
};

const LEVEL_EMOJI: Record<ContextBudgetLevel, string> = {
  yellow: "🟡",
  red: "🟠",
  critical: "🔴",
};

/**
 * Classify a context token count. Returns null below the yellow threshold so
 * normal operation produces no warning (false-positive avoidance).
 */
export function classifyContextBudget(
  tokens: number,
  thresholds: ContextBudgetThresholds = getThresholds()
): ContextBudgetLevel | null {
  if (!Number.isFinite(tokens) || tokens < thresholds.yellow) return null;
  if (tokens >= thresholds.critical) return "critical";
  if (tokens >= thresholds.red) return "red";
  return "yellow";
}

function formatK(tokens: number): string {
  // floor (not round) so the displayed value never overstates the band — e.g.
  // 399_999 shows "399k (>=300k)", not a misleading "400k" (the red threshold).
  return `${Math.floor(tokens / 1000)}k`;
}

/**
 * Build the Discord warning text for a classified level. Always references
 * `/session compact` (the notify-only recovery the user runs) and Issue #204 so
 * the alert is self-documenting.
 */
export function buildContextBudgetWarning(
  tokens: number,
  level: ContextBudgetLevel,
  thresholds: ContextBudgetThresholds = getThresholds()
): string {
  const now = formatK(tokens);
  const emoji = LEVEL_EMOJI[level];
  if (level === "critical") {
    return `${emoji} このセッションのコンテキストが ${now} (>=${formatK(thresholds.critical)}) に到達。高コンテキストで tool 呼び出しが破損し黙って停止する恐れがあります (#204)。直ちに \`/session compact\` するか新セッションへ切替えてください。`;
  }
  if (level === "red") {
    return `${emoji} このセッションのコンテキストが ${now} (>=${formatK(thresholds.red)}) を超過 (context rot 領域)。\`/session compact\` を強く推奨します (#204)。`;
  }
  return `${emoji} このセッションのコンテキストが ${now} (>=${formatK(thresholds.yellow)}) に到達 (context rot の入り口)。区切りの良い所で \`/session compact\` を検討してください (#204)。`;
}

export interface ContextBudgetWarning {
  level: ContextBudgetLevel;
  message: string;
  tokens: number;
}

export interface ContextBudgetTracker {
  /**
   * Feed the latest context token count for a session. Returns a warning only
   * when the session crosses *up* into a higher level than already warned in
   * the current above-yellow episode — so a steady high-context session is not
   * re-warned every turn (de-dup). Dropping below the yellow threshold (e.g.
   * after a `/session compact`) resets the episode so a later climb re-warns.
   * `null` / non-finite input is treated as "no signal" and never warns.
   */
  check(tokens: number | null | undefined): ContextBudgetWarning | null;
}

/**
 * Per-session de-dup tracker. The supervisor holds one per thread; thresholds
 * are snapshotted at creation (process env is stable after start).
 */
export function createContextBudgetTracker(
  thresholds: ContextBudgetThresholds = getThresholds()
): ContextBudgetTracker {
  let warnedRank = 0; // 0 = below yellow / nothing warned this episode

  return {
    check(tokens) {
      if (tokens == null || !Number.isFinite(tokens)) return null;
      const level = classifyContextBudget(tokens, thresholds);
      if (!level) {
        // Below yellow — reset the episode so post-compact recovery re-arms.
        warnedRank = 0;
        return null;
      }
      const rank = LEVEL_RANK[level];
      if (rank < warnedRank) {
        // Dropped to a lower (but still >= yellow) band — e.g. a partial
        // /session compact that shaved one band but not below yellow. Lower the
        // high-water mark so a later climb back up re-warns, while the downward
        // move itself stays silent (we never warn on shrinking context).
        warnedRank = rank;
        return null;
      }
      if (rank <= warnedRank) return null; // same band — already warned, no spam
      warnedRank = rank;
      return {
        level,
        message: buildContextBudgetWarning(tokens, level, thresholds),
        tokens,
      };
    },
  };
}
