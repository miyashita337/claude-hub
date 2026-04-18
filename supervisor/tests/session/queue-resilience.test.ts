import { test, expect, describe } from "bun:test";

/**
 * Tests for the enqueueForThread pattern used in bot.ts (#41).
 * Verifies that the thread message queue recovers from task failures
 * instead of permanently blocking subsequent messages.
 */

// Reproduce the enqueueForThread implementation (safe version from fix)
function createSafeQueue() {
  const threadQueues = new Map<string, Promise<void>>();
  const log: string[] = [];

  function enqueueForThread(threadId: string, task: () => Promise<void>): void {
    const prev = threadQueues.get(threadId) ?? Promise.resolve();
    const safeTask = async () => {
      try {
        await task();
      } catch (err) {
        log.push(`caught: ${err}`);
      }
    };
    const next = prev.then(safeTask, safeTask);
    threadQueues.set(threadId, next);
    next.finally(() => {
      if (threadQueues.get(threadId) === next) {
        threadQueues.delete(threadId);
      }
    });
  }

  return { enqueueForThread, threadQueues, log };
}


describe("enqueueForThread resilience (#41)", () => {
  test("safe queue: task error does not block subsequent tasks", async () => {
    const { enqueueForThread, log } = createSafeQueue();
    const results: string[] = [];

    // Task 1: throws an error
    enqueueForThread("thread-1", async () => {
      throw new Error("relay failed");
    });

    // Task 2: should still execute despite Task 1 failure
    const task2Done = new Promise<void>((resolve) => {
      enqueueForThread("thread-1", async () => {
        results.push("task2-ok");
        resolve();
      });
    });

    await task2Done;
    expect(results).toContain("task2-ok");
    expect(log).toContain("caught: Error: relay failed");
  });

  test("safe queue: multiple consecutive errors don't accumulate", async () => {
    const { enqueueForThread, log } = createSafeQueue();
    const results: string[] = [];

    // 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      enqueueForThread("thread-1", async () => {
        throw new Error(`fail-${i}`);
      });
    }

    // Task 4: should still work
    const task4Done = new Promise<void>((resolve) => {
      enqueueForThread("thread-1", async () => {
        results.push("task4-ok");
        resolve();
      });
    });

    await task4Done;
    expect(results).toContain("task4-ok");
    expect(log.length).toBe(3);
  });

  test("safe queue: different threads are independent", async () => {
    const { enqueueForThread } = createSafeQueue();
    const results: string[] = [];

    // Thread A fails
    enqueueForThread("thread-A", async () => {
      throw new Error("A failed");
    });

    // Thread B should be unaffected
    const taskBDone = new Promise<void>((resolve) => {
      enqueueForThread("thread-B", async () => {
        results.push("B-ok");
        resolve();
      });
    });

    await taskBDone;
    expect(results).toContain("B-ok");
  });

  test("safe queue: tasks execute in order within a thread", async () => {
    const { enqueueForThread } = createSafeQueue();
    const order: number[] = [];

    const allDone = new Promise<void>((resolve) => {
      for (let i = 1; i <= 5; i++) {
        enqueueForThread("thread-1", async () => {
          order.push(i);
          if (i === 5) resolve();
        });
      }
    });

    await allDone;
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  test("safe queue: catches errors that were unhandled before #41 fix", async () => {
    const { enqueueForThread, log } = createSafeQueue();

    // Before #41 fix, this error would propagate as an unhandled rejection,
    // crashing the process or permanently blocking the queue chain.
    enqueueForThread("thread-1", async () => {
      throw new Error("would be unhandled without safeTask wrapper");
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(log.length).toBe(1);
    expect(log[0]).toContain("would be unhandled");
  });

  test("safe queue: error in error-handler does not block queue", async () => {
    const { enqueueForThread, log } = createSafeQueue();
    const results: string[] = [];

    // Simulate the real bug: relay fails, then error notification also fails
    enqueueForThread("thread-1", async () => {
      try {
        throw new Error("relay failed");
      } catch {
        // Simulate thread.send() failing (Discord API error)
        throw new Error("Discord send failed");
      }
    });

    // Next message should still work
    const task2Done = new Promise<void>((resolve) => {
      enqueueForThread("thread-1", async () => {
        results.push("recovered");
        resolve();
      });
    });

    await task2Done;
    expect(results).toContain("recovered");
    expect(log).toContain("caught: Error: Discord send failed");
  });
});
