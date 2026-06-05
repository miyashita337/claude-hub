import { test, expect, describe } from "bun:test";
import { scheduleStallHeartbeat } from "../../src/session/stall-heartbeat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scheduleStallHeartbeat", () => {
  // Delays are widened (vs. 5-30ms) so scheduler jitter under CI load can't
  // flip the boundary assertions (coderabbit #195).
  test("fires once after the delay elapses", async () => {
    let fired = 0;
    scheduleStallHeartbeat({ delayMs: 60, fire: () => void fired++ });
    await sleep(180);
    expect(fired).toBe(1);
  });

  test("does not fire when cancelled before the delay", async () => {
    let fired = 0;
    const hb = scheduleStallHeartbeat({ delayMs: 80, fire: () => void fired++ });
    await sleep(20);
    hb.cancel();
    await sleep(150);
    expect(fired).toBe(0);
  });

  test("cancel is idempotent and safe after firing", async () => {
    let fired = 0;
    const hb = scheduleStallHeartbeat({ delayMs: 40, fire: () => void fired++ });
    await sleep(120);
    expect(fired).toBe(1);
    hb.cancel();
    hb.cancel();
    await sleep(80);
    expect(fired).toBe(1);
  });

  test("does not throw when fire() rejects", async () => {
    scheduleStallHeartbeat({
      delayMs: 40,
      fire: async () => {
        throw new Error("page failed");
      },
    });
    await sleep(150); // would surface an unhandled rejection if not caught
    expect(true).toBe(true);
  });
});
