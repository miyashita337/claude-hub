import { describe, expect, test } from "bun:test";
import {
  ProgressBuffer,
  type ProgressEntry,
} from "../../src/session/progress-buffer";

interface FlushCall {
  threadId: string;
  entries: ProgressEntry[];
}

describe("ProgressBuffer (#119)", () => {
  test("coalesces multiple entries within interval into a single onFlush call", async () => {
    const flushes: FlushCall[] = [];
    const buf = new ProgressBuffer({
      intervalMs: 50,
      onFlush: (threadId, entries) => {
        flushes.push({ threadId, entries });
      },
    });

    buf.add("t1", { tool: "Read", message: "src/a.ts" });
    buf.add("t1", { tool: "Bash", message: "bun test (exit: 0)" });
    buf.add("t1", { tool: "Edit", message: "src/b.ts" });

    await new Promise((r) => setTimeout(r, 80));

    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.threadId).toBe("t1");
    expect(flushes[0]?.entries.map((e) => e.tool)).toEqual([
      "Read",
      "Bash",
      "Edit",
    ]);
  });

  test("emits separate onFlush calls when entries straddle two windows", async () => {
    const flushes: FlushCall[] = [];
    const buf = new ProgressBuffer({
      intervalMs: 30,
      onFlush: (threadId, entries) => {
        flushes.push({ threadId, entries });
      },
    });

    buf.add("t1", { tool: "Read", message: "a" });
    await new Promise((r) => setTimeout(r, 60));
    buf.add("t1", { tool: "Write", message: "b" });
    await new Promise((r) => setTimeout(r, 60));

    expect(flushes).toHaveLength(2);
    expect(flushes[0]?.entries[0]?.tool).toBe("Read");
    expect(flushes[1]?.entries[0]?.tool).toBe("Write");
  });

  test("isolates buffers per thread", async () => {
    const flushes: FlushCall[] = [];
    const buf = new ProgressBuffer({
      intervalMs: 30,
      onFlush: (threadId, entries) => {
        flushes.push({ threadId, entries });
      },
    });

    buf.add("t1", { tool: "Read", message: "a" });
    buf.add("t2", { tool: "Bash", message: "ls" });

    await new Promise((r) => setTimeout(r, 60));

    expect(flushes).toHaveLength(2);
    const t1Flush = flushes.find((f) => f.threadId === "t1");
    const t2Flush = flushes.find((f) => f.threadId === "t2");
    expect(t1Flush?.entries.map((e) => e.tool)).toEqual(["Read"]);
    expect(t2Flush?.entries.map((e) => e.tool)).toEqual(["Bash"]);
  });

  test("flush() on empty buffer is a no-op", async () => {
    let calls = 0;
    const buf = new ProgressBuffer({
      intervalMs: 100,
      onFlush: () => {
        calls++;
      },
    });

    await buf.flush("nonexistent");
    expect(calls).toBe(0);
  });

  test("flushAll() drains all pending threads immediately (before interval fires)", async () => {
    const flushes: FlushCall[] = [];
    const buf = new ProgressBuffer({
      intervalMs: 60_000, // long enough that the interval timer would not fire on its own
      onFlush: (threadId, entries) => {
        flushes.push({ threadId, entries });
      },
    });

    buf.add("t1", { tool: "Read", message: "a" });
    buf.add("t2", { tool: "Bash", message: "ls" });
    buf.add("t1", { tool: "Edit", message: "b" });

    await buf.flushAll();

    expect(flushes).toHaveLength(2);
    expect(buf.pendingThreadIds()).toEqual([]);
    const t1Flush = flushes.find((f) => f.threadId === "t1");
    expect(t1Flush?.entries).toHaveLength(2);
  });

  test("close() cancels timers, drops buffered entries, and silently rejects further add()", async () => {
    const flushes: FlushCall[] = [];
    const buf = new ProgressBuffer({
      intervalMs: 30,
      onFlush: (threadId, entries) => {
        flushes.push({ threadId, entries });
      },
    });

    buf.add("t1", { tool: "Read", message: "a" });
    buf.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(flushes).toHaveLength(0);

    // add() after close is silently dropped (no flush emitted, no buffered state)
    buf.add("t1", { tool: "Bash", message: "should not flush" });
    await new Promise((r) => setTimeout(r, 60));
    expect(flushes).toHaveLength(0);
    expect(buf.pendingThreadIds()).toEqual([]);
  });
});
