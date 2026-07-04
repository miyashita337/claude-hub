import { DISPATCH_MAX_CONCURRENT } from "../config/channels";

/**
 * Dispatch concurrency limiter + FIFO queue (Phase 5c / #294, Epic #292).
 *
 * The multi-session timeout問題 is CPU run-queue saturation: MAX_SESSIONS=10 only
 * rejects the 11th, it does not stop 10 dispatches from starting at once and
 * driving load ≫ cores. This gates *dispatch* starts to at most
 * `DISPATCH_MAX_CONCURRENT` concurrent; a dispatch over the limit is QUEUED (not
 * rejected) and started FIFO as running dispatches end.
 *
 * Interactive `/session start` does NOT go through this queue — it starts
 * immediately (capped only by MAX_SESSIONS), so the human experience is unchanged
 * (AC-3). Only `handleDispatchMessage` submits here.
 *
 * A slot is held for the whole session lifetime: {@link submit}/{@link pump}
 * mark the threadId active when a start begins, and the owner frees it via
 * {@link notifyEnded} when the session actually ends (the SessionManager calls it
 * from stop / tmux-exit / headless-finish). This is why `run()` returns whether a
 * session actually started: if it did (tmux: session outlives run(); headless:
 * notifyEnded already fired), the slot stays until the end event; if it did not
 * (thread/start/spawn failure), the queue frees the slot immediately so it is
 * never leaked.
 *
 * Restart handling (chosen + justified): the queue is IN-MEMORY and lost on a
 * supervisor restart. Persisting it (DB + dedup-on-restart) was rejected as
 * unjustified complexity: corp's reconcile loop re-detects an incomplete Issue
 * and re-dispatches it, so a dropped queued dispatch self-heals upstream. This
 * mirrors the existing "supervisor restart drops in-flight relay state" posture.
 */

/** One unit of dispatch work managed by the queue. `key` is the (unique) threadId. */
export interface QueuedDispatch {
  key: string;
  /**
   * Perform the dispatch. Resolves `true` when a session actually started (the
   * slot must stay held until {@link DispatchQueue.notifyEnded}), `false` when no
   * session started (queue frees the slot now). Must not throw for a normal
   * dispatch failure — return false; a throw is treated as false with a log.
   */
  run: () => Promise<boolean>;
  /** Posted when the item is placed on the queue (over the concurrency limit). `position` is 1-based. */
  onQueued: (position: number) => Promise<void>;
  /** Posted when the item leaves the queue to start (a slot freed). */
  onDequeued: () => Promise<void>;
}

export interface DispatchQueueDeps {
  maxConcurrent?: number;
  log?: Pick<Console, "error" | "warn" | "log">;
}

function resolveMaxConcurrent(): number {
  const raw = process.env.DISPATCH_MAX_CONCURRENT;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DISPATCH_MAX_CONCURRENT;
}

export class DispatchQueue {
  /** threadIds of dispatches currently occupying a concurrency slot. */
  private readonly active = new Set<string>();
  /** FIFO pending queue (over the concurrency limit). */
  private readonly pending: QueuedDispatch[] = [];
  private readonly maxConcurrent: number;
  private readonly log: Pick<Console, "error" | "warn" | "log">;

  constructor(deps: DispatchQueueDeps = {}) {
    this.maxConcurrent = deps.maxConcurrent ?? resolveMaxConcurrent();
    this.log = deps.log ?? console;
  }

  /** The concurrency limit (for status messages). */
  limit(): number {
    return this.maxConcurrent;
  }

  activeCount(): number {
    return this.active.size;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Submit a dispatch. Starts it immediately when under the concurrency limit,
   * otherwise enqueues it FIFO and calls `onQueued` with its 1-based position.
   * Returns which happened so the caller can log/report.
   */
  async submit(item: QueuedDispatch): Promise<"started" | "queued"> {
    if (this.active.size < this.maxConcurrent && !this.active.has(item.key)) {
      this.active.add(item.key);
      void this.runItem(item);
      return "started";
    }
    this.pending.push(item);
    try {
      await item.onQueued(this.pending.length);
    } catch (err) {
      this.log.error(`[DispatchQueue] onQueued failed for ${item.key}:`, err);
    }
    return "queued";
  }

  /**
   * Free the slot held by `threadId` (called by the SessionManager when a
   * dispatch session ends) and pump the queue. A no-op when the threadId does not
   * hold a slot (e.g. an interactive session ended), so interactive teardown
   * never disturbs the dispatch queue.
   */
  notifyEnded(threadId: string | undefined): void {
    if (!threadId || !this.active.has(threadId)) return;
    this.active.delete(threadId);
    this.pump();
  }

  /** Start as many queued items as free slots allow, FIFO. */
  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.active.add(item.key);
      void this.dequeueAndRun(item);
    }
  }

  private async dequeueAndRun(item: QueuedDispatch): Promise<void> {
    try {
      await item.onDequeued();
    } catch (err) {
      this.log.error(`[DispatchQueue] onDequeued failed for ${item.key}:`, err);
    }
    await this.runItem(item);
  }

  private async runItem(item: QueuedDispatch): Promise<void> {
    let started = false;
    try {
      started = await item.run();
    } catch (err) {
      this.log.error(`[DispatchQueue] run() threw for ${item.key}:`, err);
      started = false;
    }
    // No session started (failure) → the SessionManager will never emit an end
    // event for this slot, so free it here to avoid a permanent leak. When a
    // session DID start, the slot stays until notifyEnded (which, for headless,
    // has already fired by the time run() resolves).
    if (!started) this.notifyEnded(item.key);
  }
}
