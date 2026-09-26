import { SESSION_IDLE_DEFAULT_MS } from "../config/channels";

/**
 * Issue #435 — surface tmux sessions the supervisor does not own.
 *
 * The idle {@link Reaper} (and ResourceMonitor / ActivityWatchdog) only walk
 * SessionManager-registered sessions, so a tmux session on the supervisor
 * socket that the supervisor never registered (a hand-started `claude-x`, a
 * `claude-<id>` left behind with no DB row — see #246) is invisible forever and
 * squats ~300MB until reboot.
 *
 * Policy (decided in the #435 issue comment): **detect and notify, never kill.**
 * Killing needs a positive proof of ownership that an unregistered session by
 * definition lacks, and #430 showed a mis-kill of a live session is a real risk.
 * The kill policy is a follow-up (#477).
 *
 * Age is measured from the first time *this supervisor process* saw the name
 * (in-memory). A supervisor restart resets it, which can only delay a notice —
 * never fire one early — so the watch errs on the quiet side.
 */

export interface UnregisteredTmuxSighting {
  name: string;
  /** How long this supervisor process has continuously observed the session. */
  observedMs: number;
}

export interface UnregisteredTmuxWatchDeps {
  /**
   * Names of live tmux sessions on the supervisor socket that no in-memory
   * session owns. `[]` on a tmux failure (TmuxAdapter.listSessions contract);
   * {@link UnregisteredTmuxWatch.scan} treats an empty list as "no information"
   * and changes no state, so a tmux hiccup neither pages nor re-pages.
   */
  listUnregistered: () => Promise<string[]>;
  /** Deliver one batched notice. A throw means "not delivered" → retried next scan. */
  notify: (sightings: UnregisteredTmuxSighting[]) => Promise<void>;
  /** Observation time before a notice. Defaults to the idle-reaper default (6h). */
  thresholdMs?: number;
  now?: () => number;
}

export class UnregisteredTmuxWatch {
  readonly thresholdMs: number;
  private readonly now: () => number;
  /** name → first time this process saw it unregistered. */
  private readonly firstSeen = new Map<string, number>();
  /** Names already notified in their current episode (idempotency). */
  private readonly notified = new Set<string>();

  constructor(private readonly deps: UnregisteredTmuxWatchDeps) {
    this.thresholdMs = deps.thresholdMs ?? SESSION_IDLE_DEFAULT_MS;
    this.now = deps.now ?? Date.now;
  }

  isNotified(name: string): boolean {
    return this.notified.has(name);
  }

  /**
   * One pass. Returns the names notified in this pass (for tests / logging).
   * Never kills anything.
   */
  async scan(): Promise<string[]> {
    const now = this.now();
    const live = new Set(await this.deps.listUnregistered());
    // An empty list is indistinguishable from a tmux failure (listSessions
    // returns [] for both). Forgetting on it would reset the notified set and
    // re-page every already-reported session 6h later (PR review should-1), so
    // keep the state as-is; the next non-empty listing prunes genuine removals.
    if (live.size === 0) return [];

    // Forget names that are gone (killed, or now registered). A same-named
    // session created later is a new episode and may be notified again.
    for (const name of Array.from(this.firstSeen.keys())) {
      if (!live.has(name)) {
        this.firstSeen.delete(name);
        this.notified.delete(name);
      }
    }

    const due: UnregisteredTmuxSighting[] = [];
    for (const name of live) {
      const seenAt = this.firstSeen.get(name);
      if (seenAt === undefined) {
        this.firstSeen.set(name, now);
        continue;
      }
      if (this.notified.has(name)) continue;
      const observedMs = now - seenAt;
      if (observedMs >= this.thresholdMs) due.push({ name, observedMs });
    }
    if (due.length === 0) return [];

    try {
      await this.deps.notify(due);
    } catch (err) {
      console.error(
        `[UnregisteredTmuxWatch] notify failed for ${due.map((d) => d.name).join(", ")} — will retry next scan (#435):`,
        err,
      );
      return [];
    }
    for (const d of due) this.notified.add(d.name);
    return due.map((d) => d.name);
  }
}

/** Discord notice for one batch of sightings. Pure, for testing. */
export function formatUnregisteredTmuxAlert(
  sightings: UnregisteredTmuxSighting[],
): string {
  const lines = sightings.map(
    (s) =>
      `- \`${s.name}\`（Supervisor が ${(s.observedMs / 1000 / 60 / 60).toFixed(1)}h 以上観測。実際の起動はそれ以前の可能性あり）`,
  );
  return [
    `👀 Supervisor に登録されていない tmux セッションが残っています（自動回収はしません, #435）`,
    ...lines,
    "確認: `tmux -L claude-hub ls`。不要なら `tmux -L claude-hub kill-session -t <name>` で手動終了してください。",
  ].join("\n");
}
