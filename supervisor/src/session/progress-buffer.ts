export interface ProgressEntry {
  tool: string;
  message: string;
}

export interface ProgressBufferOptions {
  intervalMs?: number;
  onFlush: (threadId: string, entries: ProgressEntry[]) => Promise<void> | void;
}

const DEFAULT_INTERVAL_MS = 2000;

/**
 * Per-thread progress buffer (Issue #119).
 *
 * Coalesces PostToolUse progress events per thread for `intervalMs` (default
 * 2000ms), then emits one onFlush call with all queued entries. Without this,
 * tool-heavy turns (grep + N reads + edits) burst N messages and trip
 * Discord's 5-msg/5-sec rate limit.
 *
 * Behavior: the first add() per thread arms a setTimeout. Subsequent add()
 * within the window append to the same buffer. After flush the buffer + timer
 * are cleared so the next add() opens a fresh window — i.e. fixed-interval
 * coalesce, no leading-edge debounce.
 */
export class ProgressBuffer {
  private buffers = new Map<string, ProgressEntry[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly intervalMs: number;
  private readonly onFlush: (
    threadId: string,
    entries: ProgressEntry[]
  ) => Promise<void> | void;
  private closed = false;

  constructor(opts: ProgressBufferOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onFlush = opts.onFlush;
  }

  add(threadId: string, entry: ProgressEntry): void {
    if (this.closed) return;
    const buf = this.buffers.get(threadId);
    if (buf) {
      buf.push(entry);
      return;
    }
    this.buffers.set(threadId, [entry]);
    const t = setTimeout(() => {
      // Catch background rejections so a throwing onFlush can't surface as
      // an unhandledRejection and destabilize the process.
      this.flush(threadId).catch((err) => {
        console.error(
          `[ProgressBuffer] Background flush failed for thread ${threadId}:`,
          err
        );
      });
    }, this.intervalMs);
    this.timers.set(threadId, t);
  }

  async flush(threadId: string): Promise<void> {
    const t = this.timers.get(threadId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(threadId);
    }
    const entries = this.buffers.get(threadId);
    this.buffers.delete(threadId);
    if (!entries || entries.length === 0) return;
    await this.onFlush(threadId, entries);
  }

  async flushAll(): Promise<void> {
    const threadIds = Array.from(this.buffers.keys());
    await Promise.all(threadIds.map((id) => this.flush(id)));
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.buffers.clear();
  }

  pendingThreadIds(): string[] {
    return Array.from(this.buffers.keys());
  }
}
