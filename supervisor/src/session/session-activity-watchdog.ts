/**
 * Session activity watchdog (Issue #209).
 *
 * Existing safeguards each cover a *different timescale* and leave a gap:
 *   - the stall heartbeat ({@link import("./stall-heartbeat")}) is per relay turn
 *     (3 min, below the relay timeout — RELAY_TIMEOUT_MS, default 15 min),
 *   - the reaper ({@link import("./reaper").Reaper}) only acts after 7 days idle,
 *   - the context-budget monitor ({@link import("./context-budget")}) fires on
 *     high token counts reported by the Stop hook (#204).
 *
 * None of them notice a session that is *alive but has been running for hours*
 * or has gone quiet at the session timescale. That gap is exactly what #209
 * hit: a dispatched session ran ~21h at 33% ctx without any proactive Discord
 * report, so it looked "dead" to the owner while genuinely working.
 *
 * This watchdog periodically scans the live sessions and emits at most one
 * Discord nudge per signal (de-dup), driven by two numeric thresholds:
 *   - quiet     — no activity for `quietMs` (default 60 min)  → AC1
 *   - long_lived — running for `longLivedMs` (default 6 h)     → AC3
 *
 * Detection is purely numeric (elapsed/idle ms) — NOT a TUI string match — so a
 * Claude Code TUI update cannot silently break it (RW-027 consistency). AC2
 * (mandatory completion report) needs agent-side cooperation and is tracked
 * separately in #211.
 */

export type ActivityLevel = "quiet" | "long_lived";

export interface ActivityThresholds {
  /** No activity for this long → "quiet" (running but no report). */
  quietMs: number;
  /** Running for this long → "long_lived" (abnormally long lifetime). */
  longLivedMs: number;
}

/** A single observation of a session's age and idle time. */
export interface ActivitySample {
  /** ms since the session started. */
  ageMs: number;
  /** ms since the last recorded activity (inbound or outbound). */
  idleMs: number;
}

export interface ActivityWarning {
  level: ActivityLevel;
  message: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Thresholds. Env-overridable for tuning and tests; read at call time (not at
 * module load) so a test can set env per-case. Defaults: a session is "quiet"
 * after 60 min of no activity and "long-lived" after 6 h of runtime.
 */
export function getActivityThresholds(): ActivityThresholds {
  return {
    quietMs: envInt("SESSION_QUIET_WARN_MS", 60 * MINUTE_MS),
    longLivedMs: envInt("SESSION_LONG_LIVED_WARN_MS", 6 * HOUR_MS),
  };
}

/**
 * Classify a single sample. `long_lived` takes precedence over `quiet` (a
 * session running 21h is the headline even if it is also quiet). Returns null
 * when neither threshold is met — the common, healthy case — so a steady active
 * session produces no warning (false-positive avoidance).
 *
 * NOTE: {@link createActivityTracker} intentionally re-derives these two
 * conditions inline (it needs both booleans independently for per-signal
 * de-dup, not just the priority winner). Keep the threshold comparisons here and
 * there in sync — both are exercised by the test suite.
 */
export function classifyActivity(
  sample: ActivitySample,
  thresholds: ActivityThresholds = getActivityThresholds()
): ActivityLevel | null {
  const { ageMs, idleMs } = sample;
  if (Number.isFinite(ageMs) && ageMs >= thresholds.longLivedMs) {
    return "long_lived";
  }
  if (Number.isFinite(idleMs) && idleMs >= thresholds.quietMs) {
    return "quiet";
  }
  return null;
}

/**
 * Human-friendly duration: minutes below an hour, else `H時間` (+`M分` when the
 * remainder is non-zero). Floored so the displayed value never overstates.
 */
function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (totalMin < 60) return `${totalMin}分`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `${hours}時間` : `${hours}時間${min}分`;
}

/**
 * Build the Discord nudge for a classified level. Both messages cite #209 so
 * the alert is self-documenting and suggest a concrete next step.
 */
export function buildActivityWarning(
  level: ActivityLevel,
  sample: ActivitySample,
  _thresholds: ActivityThresholds = getActivityThresholds()
): string {
  if (level === "long_lived") {
    return `⏳ このセッションは約 ${formatDuration(sample.ageMs)} 稼働し続けています（生存中・完了報告なし）。意図せず長引いている / stall していないか確認してください。\`/session status\` で生死確認、\`/session compact\` も検討 (#209)。`;
  }
  return `⚠️ このセッションは約 ${formatDuration(sample.idleMs)} 無活動です（稼働中だが無報告）。停止していないか確認してください (#209)。`;
}

export interface ActivityTracker {
  /**
   * Feed the latest sample. Returns a warning when a signal first appears,
   * then de-dups so a steady condition is not re-warned every tick:
   *   - long_lived re-fires on entry to each escalating age band (6h → 12h →
   *     24h → 48h …, doubling) so a multi-day session keeps surfacing instead
   *     of going silent after the first nudge (Issue #221); same-band ticks
   *     de-dup,
   *   - quiet warns once per quiet *episode* — when activity resumes (idle drops
   *     below the threshold) the episode resets so a later silence re-warns.
   * The two signals are tracked independently.
   */
  check(sample: ActivitySample): ActivityWarning | null;
}

/**
 * Per-session de-dup tracker. The watchdog holds one per live thread and drops
 * it when the session disappears. Thresholds are snapshotted at creation.
 */
/**
 * Escalating "age band" for the long_lived signal (Issue #221). Returns 0 below
 * the threshold, then 1 at `longLivedMs`, 2 at 2×, 3 at 4×, … (doubling). The
 * tracker re-fires long_lived each time the band increases, so a session kept
 * alive for days keeps surfacing (6h → 12h → 24h → 48h …) instead of going
 * permanently silent after the first nudge — the #221 one-shot bug.
 */
export function longLivedBand(ageMs: number, longLivedMs: number): number {
  if (!Number.isFinite(ageMs) || longLivedMs <= 0 || ageMs < longLivedMs) {
    return 0;
  }
  return Math.floor(Math.log2(ageMs / longLivedMs)) + 1;
}

export function createActivityTracker(
  thresholds: ActivityThresholds = getActivityThresholds()
): ActivityTracker {
  // Highest long_lived age band already warned (Issue #221). 0 = none yet.
  let warnedBand = 0;
  let quietWarned = false;

  return {
    check(sample) {
      const { ageMs, idleMs } = sample;
      const band = longLivedBand(ageMs, thresholds.longLivedMs);
      const longLived = band > 0;
      const quiet = Number.isFinite(idleMs) && idleMs >= thresholds.quietMs;

      // Re-arm the quiet episode as soon as the session is active again.
      if (!quiet) quietWarned = false;

      // Fire long_lived on entry to a *new* (higher) age band so a multi-day
      // session keeps surfacing (6h → 12h → 24h …) instead of going silent
      // after the first nudge (Issue #221). Same-band ticks de-dup.
      if (longLived && band > warnedBand) {
        warnedBand = band;
        // Suppress an *immediately* redundant quiet follow-up: when a session is
        // both long-lived and already quiet, the long_lived nudge covers it, so
        // don't also fire quiet on the next tick. We only mark quiet warned when
        // it is quiet *now* — so a session that was active when long_lived fired
        // and falls silent *later* still gets its own quiet alert (re-armed by
        // the `if (!quiet)` reset above).
        if (quiet) quietWarned = true;
        return {
          level: "long_lived",
          message: buildActivityWarning("long_lived", sample, thresholds),
        };
      }
      if (quiet && !quietWarned) {
        quietWarned = true;
        return {
          level: "quiet",
          message: buildActivityWarning("quiet", sample, thresholds),
        };
      }
      return null;
    },
  };
}

/** Minimal session shape the watchdog reads. */
interface WatchdogSession {
  startedAt: Date;
  lastActivityAt: Date;
}

export interface ActivityWatchdogDeps {
  /** Live in-memory sessions (e.g. `sessionManager.entries()`). */
  entries(): IterableIterator<[string, WatchdogSession]>;
  /**
   * Authoritative liveness for a thread. Dead sessions are skipped — the reaper
   * owns terminating them; warning about a dead session would be noise. May be
   * sync or async: `check()` awaits it, so the async `sessionManager.livenessOf`
   * (Issue #227 PR-3) and a sync test fake both satisfy this.
   */
  isAlive(threadId: string): boolean | Promise<boolean>;
  /** Deliver a warning (best-effort; throwing is caught per-session). */
  notify(threadId: string, warning: ActivityWarning): void | Promise<void>;
  thresholds?: ActivityThresholds;
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Default scan cadence. Coarser than the relay timescale, finer than the reaper. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 10 * MINUTE_MS;

/**
 * Periodic driver (mirrors {@link import("./reaper").Reaper}'s shape). Holds one
 * {@link ActivityTracker} per live thread for de-dup and GCs trackers whose
 * session has gone. The pure logic lives in the functions above; this class is a
 * thin timer + notify shell so it stays trivially testable via `check()`.
 */
export class ActivityWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly trackers = new Map<string, ActivityTracker>();
  private readonly thresholds: ActivityThresholds;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: ActivityWatchdogDeps) {
    this.thresholds = deps.thresholds ?? getActivityThresholds();
    this.intervalMs =
      deps.intervalMs ??
      envInt("SESSION_WATCHDOG_INTERVAL_MS", DEFAULT_WATCHDOG_INTERVAL_MS);
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    // Don't keep the event loop alive solely for this timer.
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
    console.log(
      `[ActivityWatchdog] Started (interval ${this.intervalMs / MINUTE_MS}min, quiet ${this.thresholds.quietMs / MINUTE_MS}min, longLived ${this.thresholds.longLivedMs / HOUR_MS}h)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One scan pass. Public so tests can drive it deterministically. */
  async check(): Promise<void> {
    const now = this.now();
    const live = new Set<string>();
    let scanned = 0;
    let aliveCount = 0;
    let warned = 0;

    for (const [threadId, session] of this.deps.entries()) {
      live.add(threadId);
      scanned++;

      let alive: boolean;
      try {
        alive = await this.deps.isAlive(threadId);
      } catch (err) {
        console.warn(
          `[ActivityWatchdog] isAlive(${threadId}) threw:`,
          err
        );
        continue;
      }
      if (!alive) continue;
      aliveCount++;

      const ageMs = now - session.startedAt.getTime();
      const idleMs = now - session.lastActivityAt.getTime();

      let tracker = this.trackers.get(threadId);
      if (!tracker) {
        tracker = createActivityTracker(this.thresholds);
        this.trackers.set(threadId, tracker);
      }

      const warning = tracker.check({ ageMs, idleMs });
      if (warning) {
        warned++;
        // Sequential await: for the supervisor's small session count
        // (MAX_SESSIONS = 10) even an all-cross-at-once burst stays well under
        // Discord's global rate limit. notify() is best-effort and isolated —
        // one failure must not abort the rest of the scan.
        try {
          await this.deps.notify(threadId, warning);
        } catch (err) {
          console.warn(
            `[ActivityWatchdog] notify(${threadId}) failed:`,
            err
          );
        }
      }
    }

    // GC tracker state for sessions that have disappeared so a thread id reused
    // by a brand-new session starts from a clean de-dup slate.
    for (const id of this.trackers.keys()) {
      if (!live.has(id)) this.trackers.delete(id);
    }

    // Heartbeat so a silently-stopped watchdog is detectable in logs (RW-023:
    // an unobserved background writer can die for days unnoticed).
    console.debug(
      `[ActivityWatchdog] scan: ${scanned} sessions, ${aliveCount} alive, ${warned} warned`
    );
  }
}
