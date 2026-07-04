import { describe, test, expect, spyOn } from "bun:test";
import {
  AdmissionController,
  resolveAdmissionMode,
  type LoadSampler,
  type SystemSample,
} from "../../src/session/admission";
import { ResourceMonitor } from "../../src/session/resource-monitor";
import type { SessionManager } from "../../src/session/manager";

/**
 * Phase 5d / #295 (Epic #292 AC-4 / AC-5): WARN-first dynamic admission. Default
 * observe mode logs a WARN under high load but never delays; enforce mode delays.
 * A fake sampler injects the load so no real system metrics are read.
 */

function sampler(load1: number, cores = 10): LoadSampler {
  const s: SystemSample = { load1, cores, freeMemRatio: 0.5 };
  return { sample: () => s };
}

describe("resolveAdmissionMode", () => {
  test("defaults to observe; only DISPATCH_ADMISSION_ENFORCE=1 enables enforce", () => {
    expect(resolveAdmissionMode({})).toBe("observe");
    expect(resolveAdmissionMode({ DISPATCH_ADMISSION_ENFORCE: "1" })).toBe(
      "enforce",
    );
    expect(resolveAdmissionMode({ DISPATCH_ADMISSION_ENFORCE: "0" })).toBe(
      "observe",
    );
    expect(resolveAdmissionMode({ DISPATCH_ADMISSION_ENFORCE: "true" })).toBe(
      "observe",
    );
  });
});

describe("AdmissionController.evaluate", () => {
  test("low load (≤ cores) → no warn, no delay", () => {
    const c = new AdmissionController({ sampler: sampler(4, 10), mode: "observe" });
    const d = c.evaluate();
    expect(d.warn).toBeNull();
    expect(d.delayMs).toBe(0);
  });

  test("high load, observe (default) → WARN but NO delay (WARN-first, AC-5)", () => {
    const c = new AdmissionController({ sampler: sampler(15, 10), mode: "observe" });
    const d = c.evaluate();
    expect(d.warn).toContain("high load");
    expect(d.warn).toContain("observe only");
    expect(d.delayMs).toBe(0);
  });

  test("high load, enforce → WARN and a positive delay (AC-4)", () => {
    const c = new AdmissionController({
      sampler: sampler(21, 10),
      mode: "enforce",
      delayMs: 5000,
    });
    const d = c.evaluate();
    expect(d.warn).toContain("high load");
    expect(d.delayMs).toBe(5000);
  });

  test("loadFactor scales the ceiling", () => {
    // ceiling = cores(10) * 0.5 = 5 → load 6 is over.
    const c = new AdmissionController({
      sampler: sampler(6, 10),
      mode: "observe",
      loadFactor: 0.5,
    });
    expect(c.evaluate().warn).toContain("high load");
  });
});

describe("AdmissionController.gate", () => {
  test("observe mode logs the WARN and does not sleep (AC-5)", async () => {
    const warns: string[] = [];
    const sleeps: number[] = [];
    const c = new AdmissionController({ sampler: sampler(15, 10), mode: "observe" });
    await c.gate({ warn: (m: string) => warns.push(m) }, async (ms) => {
      sleeps.push(ms);
    });
    expect(warns).toHaveLength(1);
    expect(sleeps).toHaveLength(0); // no delay in observe mode
  });

  test("enforce mode logs the WARN and sleeps the delay (AC-4)", async () => {
    const warns: string[] = [];
    const sleeps: number[] = [];
    const c = new AdmissionController({
      sampler: sampler(15, 10),
      mode: "enforce",
      delayMs: 5000,
    });
    await c.gate({ warn: (m: string) => warns.push(m) }, async (ms) => {
      sleeps.push(ms);
    });
    expect(warns).toHaveLength(1);
    expect(sleeps).toEqual([5000]);
  });

  test("low load: no warn, no sleep", async () => {
    const warns: string[] = [];
    const sleeps: number[] = [];
    const c = new AdmissionController({ sampler: sampler(3, 10), mode: "enforce" });
    await c.gate({ warn: (m: string) => warns.push(m) }, async (ms) => {
      sleeps.push(ms);
    });
    expect(warns).toHaveLength(0);
    expect(sleeps).toHaveLength(0);
  });
});

describe("ResourceMonitor.sampleLoad (#295 periodic observation)", () => {
  const emptyManager = {
    entries: () => new Map().entries(),
  } as unknown as SessionManager;

  test("logs a WARN when load is high (observe-only, no stop)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rm = new ResourceMonitor(emptyManager, {
        admission: new AdmissionController({ sampler: sampler(18, 10), mode: "observe" }),
      });
      rm.sampleLoad();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("high load");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("stays silent when load is within the ceiling", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rm = new ResourceMonitor(emptyManager, {
        admission: new AdmissionController({ sampler: sampler(4, 10), mode: "observe" }),
      });
      rm.sampleLoad();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
