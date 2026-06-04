import { test, expect, describe } from "bun:test";
import { scheduleStallHeartbeat } from "../../src/session/stall-heartbeat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scheduleStallHeartbeat", () => {
  test("fires once after the delay elapses", async () => {
    let fired = 0;
    scheduleStallHeartbeat({ delayMs: 20, fire: () => void fired++ });
    await sleep(60);
    expect(fired).toBe(1);
  });

  test("does not fire when cancelled before the delay", async () => {
    let fired = 0;
    const hb = scheduleStallHeartbeat({ delayMs: 30, fire: () => void fired++ });
    await sleep(5);
    hb.cancel();
    await sleep(50);
    expect(fired).toBe(0);
  });

  test("cancel is idempotent and safe after firing", async () => {
    let fired = 0;
    const hb = scheduleStallHeartbeat({ delayMs: 10, fire: () => void fired++ });
    await sleep(30);
    expect(fired).toBe(1);
    hb.cancel();
    hb.cancel();
    await sleep(20);
    expect(fired).toBe(1);
  });

  test("does not throw when fire() rejects", async () => {
    scheduleStallHeartbeat({
      delayMs: 10,
      fire: async () => {
        throw new Error("page failed");
      },
    });
    await sleep(40); // would surface an unhandled rejection if not caught
    expect(true).toBe(true);
  });
});
