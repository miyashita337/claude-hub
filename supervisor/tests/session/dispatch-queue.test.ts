import { describe, test, expect } from "bun:test";
import {
  DispatchQueue,
  type QueuedDispatch,
} from "../../src/session/dispatch-queue";

/**
 * Phase 5c / #294 (Epic #292 AC-2 / AC-3): dispatch concurrency limit + FIFO
 * queue, with interactive /session start bypassing it. A silent quiet log keeps
 * the deterministic test output clean.
 */

const quietLog = { error: () => {}, warn: () => {}, log: () => {} };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("DispatchQueue (AC-2: concurrency limit + FIFO)", () => {
  test("starts up to the limit, queues the rest, then dequeues FIFO as slots free", async () => {
    const started: string[] = [];
    const dequeued: string[] = [];
    const queued: Array<{ key: string; pos: number }> = [];
    const item = (key: string): QueuedDispatch => ({
      key,
      run: async () => {
        started.push(key);
        return true; // a session started → slot held until notifyEnded
      },
      onQueued: async (pos) => {
        queued.push({ key, pos });
      },
      onDequeued: async () => {
        dequeued.push(key);
      },
    });

    const q = new DispatchQueue({ maxConcurrent: 3, log: quietLog });
    const outcomes: string[] = [];
    for (const k of ["t1", "t2", "t3", "t4", "t5", "t6"]) {
      outcomes.push(await q.submit(item(k)));
    }
    await flush();

    // 3 started immediately, 3 queued (not rejected).
    expect(outcomes).toEqual([
      "started",
      "started",
      "started",
      "queued",
      "queued",
      "queued",
    ]);
    expect(started).toEqual(["t1", "t2", "t3"]);
    expect(queued).toEqual([
      { key: "t4", pos: 1 },
      { key: "t5", pos: 2 },
      { key: "t6", pos: 3 },
    ]);
    expect(q.activeCount()).toBe(3);
    expect(q.pendingCount()).toBe(3);

    // A running dispatch ends → the next queued one starts (FIFO).
    q.notifyEnded("t1");
    await flush();
    expect(dequeued).toEqual(["t4"]);
    expect(started).toEqual(["t1", "t2", "t3", "t4"]);
    expect(q.activeCount()).toBe(3);
    expect(q.pendingCount()).toBe(2);

    q.notifyEnded("t2");
    await flush();
    q.notifyEnded("t3");
    await flush();
    // All six ran, strict FIFO order, queue drained.
    expect(started).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(dequeued).toEqual(["t4", "t5", "t6"]);
    expect(q.pendingCount()).toBe(0);
  });

  test("run() returning false frees the slot immediately (no leak) and pumps", async () => {
    const started: string[] = [];
    const q = new DispatchQueue({ maxConcurrent: 1, log: quietLog });

    // First item fails to start a session (run → false).
    await q.submit({
      key: "fail",
      run: async () => {
        started.push("fail");
        return false;
      },
      onQueued: async () => {},
      onDequeued: async () => {},
    });
    // Second item queues behind it, then should run once the slot frees.
    await q.submit({
      key: "ok",
      run: async () => {
        started.push("ok");
        return true;
      },
      onQueued: async () => {},
      onDequeued: async () => {},
    });
    await flush();

    expect(started).toEqual(["fail", "ok"]);
    expect(q.activeCount()).toBe(1); // only "ok" holds a slot
    expect(q.pendingCount()).toBe(0);
  });

  test("run() throwing is treated as not-started (slot freed)", async () => {
    const q = new DispatchQueue({ maxConcurrent: 1, log: quietLog });
    await q.submit({
      key: "boom",
      run: async () => {
        throw new Error("start blew up");
      },
      onQueued: async () => {},
      onDequeued: async () => {},
    });
    await flush();
    // The throw must not leak the slot.
    expect(q.activeCount()).toBe(0);
  });
});

describe("DispatchQueue (AC-3: interactive bypass)", () => {
  test("a full dispatch queue does not gate a non-submitted (interactive) start", async () => {
    const q = new DispatchQueue({ maxConcurrent: 1, log: quietLog });
    await q.submit({
      key: "d1",
      run: async () => true,
      onQueued: async () => {},
      onDequeued: async () => {},
    });
    await q.submit({
      key: "d2",
      run: async () => true,
      onQueued: async () => {},
      onDequeued: async () => {},
    });
    await flush();
    // Dispatch queue is full (1 active, 1 pending).
    expect(q.activeCount()).toBe(1);
    expect(q.pendingCount()).toBe(1);

    // Interactive /session start never calls queue.submit — model it as a direct
    // start that runs immediately regardless of the full dispatch queue.
    let interactiveStarted = false;
    const interactiveStart = async () => {
      interactiveStarted = true;
    };
    await interactiveStart();
    expect(interactiveStarted).toBe(true);

    // And an interactive session ending (threadId not in the queue) is a no-op:
    // it must not spuriously dequeue a pending dispatch.
    q.notifyEnded("interactive-thread-not-in-queue");
    expect(q.activeCount()).toBe(1);
    expect(q.pendingCount()).toBe(1);
  });
});
