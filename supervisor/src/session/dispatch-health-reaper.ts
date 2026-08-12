import { SessionManager } from "./manager";
import type { StopReason } from "./types";
import type { ThreadChannel, Client } from "discord.js";
import { selectReapableDispatch } from "./orphan-dispatch-reaper";
import { realBusyChildProbe, type BusyProbeResult } from "./dispatch-child-probe";
import {
  DISPATCH_HEALTH_SILENCE_MS,
  DISPATCH_HEALTH_CHECK_INTERVAL_MS,
} from "../config/channels";
import { markTitleStopped } from "./thread-title";
import { hasPendingAsk } from "./relay-server";

/**
 * Dispatch health reaper (Issue #279) — the health-aware front line for the
 * dispatch-session lifecycle gap.
 *
 * The chairman reported dispatch sessions (branch `corp-dispatch-<N>`) going
 * silent for 2–3h with no way to tell from Discord which were stuck vs. still
 * working, so {@link import("./session-activity-watchdog").ActivityWatchdog}
 * (#209) only *nudged*. This escalates nudge → **auto-reap**, but only when it is
 * safe: a session is reaped just when it has been silent past the health horizon
 * ({@link DISPATCH_HEALTH_SILENCE_MS}, default 2h) AND its process subtree has no
 * live CI/build/test/push child (the mis-fire guard — see
 * {@link import("./dispatch-child-probe")}). Judgement is fully supervisor-local:
 * corp only posts `/dispatch` messages and cannot observe session internals, so
 * the mechanism lives here (fire-and-forget boundary preserved, no new
 * corp→claude-hub coupling).
 *
 * Layering with the existing safety nets:
 *   - This reaper (2h, health-aware) is the main path — the "重い/応答不能を自分で
 *     片付ける" behaviour the chairman asked for.
 *   - {@link import("./orphan-dispatch-reaper").OrphanDispatchReaper} (48h,
 *     unconditional) is the coarse backstop for anything this spares: a probe
 *     that stays `unknown`, or a session pinned to `busy` by a wedged child.
 *   - The 30-day {@link import("./reaper").Reaper} still owns non-dispatch
 *     (human / interactive) sessions.
 *
 * Candidate selection reuses {@link selectReapableDispatch} verbatim (one source
 * of truth for "which dispatch sessions crossed an idle horizon"); the ONLY
 * addition over the orphan reaper is the per-candidate child-process probe. That
 * probe is essential and its failure mode is fail-safe: a `busy` result (working)
 * or an `unknown` result (pane/table unreadable, or the probe threw) both SPARE
 * the session — {@link import("./manager").SessionManager.stop} removes the
 * per-branch worktree, so reaping on doubt could discard in-flight work.
 *
 * Selection is `lastActivityAt`-based (via {@link selectReapableDispatch}), and
 * `lastActivityAt` is persisted in SQLite (`infra/db.ts`) and restored on start,
 * so the silence clock survives a supervisor restart instead of resetting to the
 * process start time (#279 AC3).
 */

/** Stop reason recorded when a session is reaped by the health reaper. */
export const HEALTH_REAP_REASON: StopReason = "health_reaped";

export interface DispatchHealthReaperDeps {
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Poll interval. Defaults to {@link DISPATCH_HEALTH_CHECK_INTERVAL_MS}. */
  checkIntervalMs?: number;
  /**
   * Silence horizon after which a dispatch session becomes a reap *candidate*
   * (still gated by the child-process probe). Defaults to the
   * `DISPATCH_HEALTH_REAP_SILENCE_MS` env override, else
   * {@link DISPATCH_HEALTH_SILENCE_MS}. Env-overridable so ops can tune the
   * leash without a redeploy (mirrors the orphan reaper / ActivityWatchdog).
   */
  silenceThresholdMs?: number;
  /**
   * Child-process probe — the mis-fire guard. Returns `"busy"` (a CI/build/test
   * descendant is live → spare), `"idle"` (safe to reap), or `"unknown"`
   * (unreadable → fail-safe spare). Injectable so tests never spawn `ps`/`tmux`;
   * defaults to {@link realBusyChildProbe} over the session's tmux pane.
   */
  probe?: (threadId: string) => Promise<BusyProbeResult>;
  /**
   * Issue #416: is this thread blocked on an unanswered AskUserQuestion? Such a
   * session is silent and has no busy child, so every other guard here would
   * clear it for reaping. Defaults to the relay server's live pending map.
   */
  isAwaitingAsk?: (threadId: string) => boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Periodic driver (mirrors {@link import("./orphan-dispatch-reaper").OrphanDispatchReaper}).
 * A thin timer + probe + notify shell around the pure
 * {@link selectReapableDispatch}; the interesting logic stays testable without
 * tmux, `ps`, or a Discord gateway.
 */
export class DispatchHealthReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Re-entry guard: a `check()` awaits a probe + stop per candidate, which can
   * outlast the poll interval under load; without this two ticks could overlap
   * and both try to stop the same thread.
   */
  private isChecking = false;

  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private readonly silenceThresholdMs: number;
  private readonly probe: (threadId: string) => Promise<BusyProbeResult>;
  private readonly isAwaitingAsk: (threadId: string) => boolean;

  constructor(
    private sessionManager: SessionManager,
    private client: Client,
    deps: DispatchHealthReaperDeps = {}
  ) {
    this.now = deps.now ?? Date.now;
    this.checkIntervalMs =
      deps.checkIntervalMs ??
      envInt("DISPATCH_HEALTH_CHECK_INTERVAL_MS", DISPATCH_HEALTH_CHECK_INTERVAL_MS);
    this.silenceThresholdMs =
      deps.silenceThresholdMs ??
      envInt("DISPATCH_HEALTH_REAP_SILENCE_MS", DISPATCH_HEALTH_SILENCE_MS);
    this.probe =
      deps.probe ??
      ((threadId) =>
        realBusyChildProbe(SessionManager.tmuxSessionNameFor(threadId)));
    this.isAwaitingAsk = deps.isAwaitingAsk ?? hasPendingAsk;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.check();
    }, this.checkIntervalMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
    console.log(
      `[DispatchHealthReaper] Started (check every ${this.checkIntervalMs / 1000 / 60}min, silence ${(this.silenceThresholdMs / 1000 / 60 / 60).toFixed(1)}h + no busy child → auto-reap)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scan tick. Public so tests can drive it deterministically. Each
   * candidate is evaluated independently and any per-session error is swallowed
   * so one bad session never aborts the tick.
   */
  async check(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;
    try {
      const candidates = selectReapableDispatch(this.sessionManager.entries(), {
        idleThresholdMs: this.silenceThresholdMs,
        now: this.now(),
      });
      for (const { threadId, idleMs } of candidates) {
        try {
          await this.evaluate(threadId, idleMs);
        } catch (err) {
          console.error(
            `[DispatchHealthReaper] Error evaluating thread ${threadId}:`,
            err
          );
        }
      }
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Gate a silent candidate on the child-process probe. `idle` → reap; `busy`
   * (working) and `unknown` (unreadable) both spare — and a probe that *throws*
   * is treated as `unknown` (fail-safe): on any doubt we keep the session and
   * let ActivityWatchdog keep nudging / the 48h orphan reaper backstop it.
   */
  private async evaluate(threadId: string, idleMs: number): Promise<void> {
    // Issue #416: a session parked on an unanswered AskUserQuestion is silent
    // with no busy child — it would satisfy every reap condition here — but it
    // is waiting for the user by design. At a 2h silence horizon against a 5h
    // ask budget this reaper, not the 6h idle one, is what would actually kill
    // the wait, and stop() also removes the worktree.
    if (this.isAwaitingAsk(threadId)) {
      console.log(
        `[DispatchHealthReaper] Thread ${threadId} silent ${(idleMs / 1000 / 60 / 60).toFixed(1)}h but awaiting an AskUserQuestion answer; sparing (#416)`
      );
      return;
    }
    let probe: BusyProbeResult;
    try {
      probe = await this.probe(threadId);
    } catch (err) {
      console.warn(
        `[DispatchHealthReaper] probe(${threadId}) threw; sparing (fail-safe):`,
        err
      );
      return;
    }
    if (probe !== "idle") {
      console.log(
        `[DispatchHealthReaper] Thread ${threadId} silent ${(idleMs / 1000 / 60 / 60).toFixed(1)}h but probe=${probe}; sparing`
      );
      return;
    }
    await this.reap(threadId, idleMs);
  }

  private async reap(threadId: string, idleMs: number): Promise<void> {
    const idleHours = (idleMs / 1000 / 60 / 60).toFixed(1);
    console.log(
      `[DispatchHealthReaper] Thread ${threadId} silent ${idleHours}h with no busy child; health-reaping (health_reaped)`
    );
    try {
      await this.sessionManager.stop(threadId, HEALTH_REAP_REASON);
    } catch (err) {
      // Leave the thread untouched if the stop itself failed; the next tick (or
      // the 48h orphan reaper) retries.
      console.error(`[DispatchHealthReaper] Failed to stop ${threadId}:`, err);
      return;
    }
    await this.notifyThread(threadId, idleMs);
  }

  /**
   * Post a teardown notice, mark the title stopped, and archive the thread — the
   * same UX as the orphan reaper / GoalWatcher. Cache-first, then API fetch: the
   * thread may have been evicted from the cache on a long-running supervisor, and
   * without the fetch fallback the notice / rename / archive would be silently
   * skipped.
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
          `🧹 dispatch セッションが約 ${idleHours} 時間無応答（作業中プロセスなし）のため自動回収しました（health_reaped / #279）。CI/build 実行中のセッションは残しています。`
        );
        const stoppedName = markTitleStopped(thread.name);
        await thread.setName(stoppedName);
        await thread.setArchived(true);
      }
    } catch (err) {
      console.error(
        `[DispatchHealthReaper] Failed to notify thread ${threadId}:`,
        err
      );
    }
  }
}
