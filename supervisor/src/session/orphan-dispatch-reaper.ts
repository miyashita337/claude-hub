import type { SessionManager } from "./manager";
import type { SessionInfo, StopReason } from "./types";
import type { ThreadChannel, Client } from "discord.js";
import { DISPATCH_BRANCH_RE } from "./goal-watcher";
import {
  DISPATCH_ORPHAN_IDLE_MS,
  DISPATCH_ORPHAN_CHECK_INTERVAL_MS,
} from "../config/channels";
import { markTitleStopped } from "./thread-title";

/**
 * Orphan dispatch reaper (Issue #275, option B — the self-contained claude-hub
 * half of the dispatch-session lifecycle gap).
 *
 * A dispatch-origin session (branch `corp-dispatch-<N>`, see
 * {@link DISPATCH_BRANCH_RE}) is started fire-and-forget when the corp HQ posts
 * a `/dispatch` message. When the corp CEO session that spawned it exits, the
 * child dispatch session is NOT chain-stopped: the two are independent
 * processes and the supervisor never observes the corp exit (corp only posts
 * Discord messages — there is no exit signal). If that dispatch job also never
 * reaches `done`, it falls through every existing safety net:
 *   - {@link import("./goal-watcher").GoalWatcher} stops only `done` sessions,
 *   - the idle {@link import("./reaper").Reaper} acts only after
 *     IDLE_TIMEOUT_MS (30 days — far too slow), and
 *   - {@link import("./session-activity-watchdog").ActivityWatchdog} only nudges.
 * The orphan then squats a MAX_SESSIONS slot and starves later dispatches
 * (executor saturation / silent stall — the #275 motivation).
 *
 * This reaper is GoalWatcher's sibling for the *not-done, long-idle* case: on a
 * fixed interval it stops dispatch-origin sessions whose idle time has crossed a
 * dispatch-specific horizon ({@link DISPATCH_ORPHAN_IDLE_MS}), which is much
 * shorter than the general 30-day idle reaper. Human / interactive sessions
 * (corp conductor, department channels) are left entirely on the 30-day reaper —
 * only `corp-dispatch-<N>` sessions get the shorter leash.
 *
 * Selection is purely numeric (idle ms) — NOT a `gh` label call or TUI string
 * match — mirroring ActivityWatchdog's robustness (RW-027) and adding no new
 * corp→claude-hub structural coupling (GoalWatcher spec §12). No `done` label
 * check is needed: a `done` session is stopped by GoalWatcher within minutes
 * (2-min poll + 3-min grace), so it never survives to the multi-day orphan
 * horizon. An *active* dispatch session keeps its `lastActivityAt` fresh via
 * PostToolUse progress (bot.ts `touchActivity`), so a genuinely-working session
 * — even the 21h #209 case — has low idle and is spared. The idle guard IS the
 * "作業中は巻き込まれない" protection (#275 AC2 / RW-046 class): only a session
 * with zero activity for the full horizon is reaped, and stop() reuses the exact
 * same teardown path as the Reaper/GoalWatcher (no worktree deletion).
 *
 * `selectReapableDispatch` is exported as a pure function so a future on-demand
 * trigger (a corp-secretary CLI, or a `/session reap` command) can reuse one
 * source of truth for "which dispatch sessions are orphaned".
 */

/** Stop reason recorded when a session is reaped as an orphaned dispatch job. */
export const ORPHAN_REAP_REASON: StopReason = "orphan_reaped";

/** Minimal session shape the pure selector reads (a subset of {@link SessionInfo}). */
export interface ReapableSession {
  branch?: string;
  status: SessionInfo["status"];
  lastActivityAt: Date;
  /**
   * Executor backend (Epic #285 Phase 2). A `"headless"` dispatch session is
   * NEVER orphan-reaped: it has no external parent to be orphaned by (its
   * `claude -p` child self-terminates and is bounded by the run timeout), and it
   * has no relay progress to refresh `lastActivityAt`, so an idle-based reap
   * would wrongly fire mid-run. Its liveness is the child process, not tmux idle
   * time. Undefined is treated as `"tmux"` (the pre-#285 behaviour).
   */
  executor?: SessionInfo["executor"];
}

/** One orphaned dispatch session selected for reaping. */
export interface OrphanReapCandidate {
  threadId: string;
  /** ms since the session's last recorded activity, at selection time. */
  idleMs: number;
}

/**
 * Pure, side-effect-free selection. From the live sessions, return the
 * dispatch-origin ones (`corp-dispatch-<N>`) that are still `running` and whose
 * idle time has reached `idleThresholdMs`. Everything else is spared:
 *   - non-dispatch branches (corp conductor / work branch / `main` / no branch),
 *   - dispatch sessions still active within the window (idle < threshold) — the
 *     "作業中は巻き込まれない" guard (#275 AC2),
 *   - sessions already `stopping` (avoid double-stop).
 *
 * Exported so both the periodic {@link OrphanDispatchReaper} and any future
 * on-demand trigger share exactly one definition of "orphaned dispatch session".
 */
export function selectReapableDispatch(
  entries: Iterable<[string, ReapableSession]>,
  opts: { idleThresholdMs: number; now: number }
): OrphanReapCandidate[] {
  const out: OrphanReapCandidate[] = [];
  for (const [threadId, session] of entries) {
    if (session.status !== "running") continue;
    // Headless dispatch sessions self-terminate (Epic #285 Phase 2): their child
    // process is the authoritative liveness bound, and they have no relay to keep
    // lastActivityAt fresh, so idle-based reaping would kill a working run. Skip.
    if (session.executor === "headless") continue;
    if (!session.branch || !DISPATCH_BRANCH_RE.test(session.branch)) continue;
    const idleMs = opts.now - session.lastActivityAt.getTime();
    if (Number.isFinite(idleMs) && idleMs >= opts.idleThresholdMs) {
      out.push({ threadId, idleMs });
    }
  }
  return out;
}

export interface OrphanDispatchReaperDeps {
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Poll interval. Defaults to {@link DISPATCH_ORPHAN_CHECK_INTERVAL_MS}. */
  checkIntervalMs?: number;
  /**
   * Idle horizon after which a not-done dispatch session is orphan-reaped.
   * Defaults to the `DISPATCH_ORPHAN_IDLE_MS` env override, else the
   * {@link DISPATCH_ORPHAN_IDLE_MS} constant. Env-overridable so ops can tune
   * the leash without a redeploy (mirrors ActivityWatchdog's env thresholds).
   */
  idleThresholdMs?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Periodic driver (mirrors {@link import("./reaper").Reaper} /
 * {@link import("./goal-watcher").GoalWatcher}). A thin timer + notify shell
 * around the pure {@link selectReapableDispatch}; the interesting logic stays
 * testable without tmux or a Discord gateway.
 */
export class OrphanDispatchReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Re-entry guard (mirrors {@link import("./goal-watcher").GoalWatcher}). A
   * `check()` awaits a stop() per candidate, which can outlast the poll interval
   * under load; without this two ticks could overlap and both try to stop the
   * same thread.
   */
  private isChecking = false;

  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private readonly idleThresholdMs: number;

  constructor(
    private sessionManager: SessionManager,
    private client: Client,
    deps: OrphanDispatchReaperDeps = {}
  ) {
    this.now = deps.now ?? Date.now;
    this.checkIntervalMs =
      deps.checkIntervalMs ?? DISPATCH_ORPHAN_CHECK_INTERVAL_MS;
    this.idleThresholdMs =
      deps.idleThresholdMs ??
      envInt("DISPATCH_ORPHAN_IDLE_MS", DISPATCH_ORPHAN_IDLE_MS);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.check();
    }, this.checkIntervalMs);
    console.log(
      `[OrphanDispatchReaper] Started (check every ${this.checkIntervalMs / 1000 / 60}min, orphan idle ${(this.idleThresholdMs / 1000 / 60 / 60).toFixed(1)}h)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scan tick. Public so tests can drive it deterministically (the interval
   * just calls it). Each candidate is reaped independently and any per-session
   * error is swallowed so one bad session never aborts the tick.
   */
  async check(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;
    try {
      const candidates = selectReapableDispatch(this.sessionManager.entries(), {
        idleThresholdMs: this.idleThresholdMs,
        now: this.now(),
      });
      for (const { threadId, idleMs } of candidates) {
        try {
          await this.reap(threadId, idleMs);
        } catch (err) {
          console.error(
            `[OrphanDispatchReaper] Error reaping thread ${threadId}:`,
            err
          );
        }
      }
    } finally {
      this.isChecking = false;
    }
  }

  private async reap(threadId: string, idleMs: number): Promise<void> {
    const idleHours = (idleMs / 1000 / 60 / 60).toFixed(1);
    console.log(
      `[OrphanDispatchReaper] Thread ${threadId} idle ${idleHours}h without \`done\`; orphan-reaping (orphan_reaped)`
    );
    try {
      await this.sessionManager.stop(threadId, ORPHAN_REAP_REASON);
    } catch (err) {
      // Leave the thread untouched if the stop itself failed; the next tick (or
      // the idle reaper) retries.
      console.error(`[OrphanDispatchReaper] Failed to stop ${threadId}:`, err);
      return;
    }
    await this.notifyThread(threadId, idleMs);
  }

  /**
   * Post a teardown notice, mark the title stopped, and archive the thread — the
   * same UX as the Reaper / GoalWatcher. Cache-first, then API fetch: the orphan
   * horizon is long (days), so on a long-running supervisor — or after a restart
   * — the thread may have been evicted from the cache; without the fetch
   * fallback the notice / rename / archive would be silently skipped.
   */
  private async notifyThread(threadId: string, idleMs: number): Promise<void> {
    try {
      let thread = this.client.channels.cache.get(threadId) as
        | ThreadChannel
        | undefined;
      if (!thread) {
        thread = (await this.client.channels
          .fetch(threadId)
          .catch(() => undefined)) as ThreadChannel | undefined;
      }

      if (thread?.isThread()) {
        const idleHours = Math.round(idleMs / 1000 / 60 / 60);
        await thread.send(
          `🧹 dispatch セッションが約 ${idleHours} 時間無活動（\`done\` 未到達）のため、orphan として自動終了しました（親 CEO セッション終了後の放置回収 / #275）。`
        );
        const stoppedName = markTitleStopped(thread.name);
        await thread.setName(stoppedName);
        await thread.setArchived(true);
      }
    } catch (err) {
      console.error(
        `[OrphanDispatchReaper] Failed to notify thread ${threadId}:`,
        err
      );
    }
  }
}
