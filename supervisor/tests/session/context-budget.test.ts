import { test, expect, describe } from "bun:test";
import {
  classifyContextBudget,
  buildContextBudgetWarning,
  createContextBudgetTracker,
  getThresholds,
  type ContextBudgetThresholds,
} from "../../src/session/context-budget";

// Explicit thresholds keep logic tests deterministic regardless of env.
const T: ContextBudgetThresholds = {
  yellow: 300_000,
  red: 400_000,
  critical: 800_000,
};

describe("classifyContextBudget", () => {
  test("returns null below yellow (Journey AC #1: no false positives)", () => {
    expect(classifyContextBudget(0, T)).toBeNull();
    expect(classifyContextBudget(299_999, T)).toBeNull();
  });

  test("classifies each band by its lower bound", () => {
    expect(classifyContextBudget(300_000, T)).toBe("yellow");
    expect(classifyContextBudget(399_999, T)).toBe("yellow");
    expect(classifyContextBudget(400_000, T)).toBe("red");
    expect(classifyContextBudget(799_999, T)).toBe("red");
    expect(classifyContextBudget(800_000, T)).toBe("critical");
    expect(classifyContextBudget(1_200_000, T)).toBe("critical");
  });

  test("non-finite input is treated as no signal (defensive)", () => {
    expect(classifyContextBudget(NaN, T)).toBeNull();
    expect(classifyContextBudget(Infinity, T)).toBeNull();
  });
});

describe("buildContextBudgetWarning", () => {
  test("yellow recommends /session compact and cites #204", () => {
    const msg = buildContextBudgetWarning(320_000, "yellow", T);
    expect(msg).toContain("🟡");
    expect(msg).toContain("320k");
    expect(msg).toContain("/session compact");
    expect(msg).toContain("#204");
  });

  test("red is a stronger recommendation", () => {
    const msg = buildContextBudgetWarning(410_000, "red", T);
    expect(msg).toContain("🟠");
    expect(msg).toContain("410k");
    expect(msg).toContain("強く推奨");
  });

  test("critical warns about the silent-stop failure mode", () => {
    const msg = buildContextBudgetWarning(850_000, "critical", T);
    expect(msg).toContain("🔴");
    expect(msg).toContain("850k");
    expect(msg).toContain("破損");
  });
});

describe("createContextBudgetTracker (de-dup, Journey AC #2/#3)", () => {
  test("warns once when first crossing into yellow", () => {
    const tr = createContextBudgetTracker(T);
    const w = tr.check(310_000);
    expect(w).not.toBeNull();
    expect(w!.level).toBe("yellow");
    expect(w!.tokens).toBe(310_000);
  });

  test("does NOT re-warn while staying in the same band", () => {
    const tr = createContextBudgetTracker(T);
    expect(tr.check(310_000)).not.toBeNull();
    expect(tr.check(320_000)).toBeNull(); // same band, no spam
    expect(tr.check(350_000)).toBeNull();
  });

  test("re-warns only when crossing UP into a higher band", () => {
    const tr = createContextBudgetTracker(T);
    expect(tr.check(310_000)!.level).toBe("yellow");
    expect(tr.check(420_000)!.level).toBe("red"); // escalation
    expect(tr.check(450_000)).toBeNull(); // still red
    expect(tr.check(820_000)!.level).toBe("critical");
    expect(tr.check(900_000)).toBeNull(); // still critical
  });

  test("never warns while below yellow", () => {
    const tr = createContextBudgetTracker(T);
    expect(tr.check(100_000)).toBeNull();
    expect(tr.check(299_999)).toBeNull();
  });

  test("dropping to a lower band (not below yellow) re-arms a re-climb (partial compact)", () => {
    const tr = createContextBudgetTracker(T);
    expect(tr.check(820_000)!.level).toBe("critical");
    expect(tr.check(410_000)).toBeNull(); // partial compact: critical → red, silent
    const back = tr.check(820_000); // climbs back to critical
    expect(back).not.toBeNull();
    expect(back!.level).toBe("critical"); // re-warned
    // ...and once re-warned at critical, it de-dups again within the band.
    expect(tr.check(900_000)).toBeNull();
  });

  test("dropping below yellow resets the episode so a re-climb re-warns (post-compact)", () => {
    const tr = createContextBudgetTracker(T);
    expect(tr.check(420_000)!.level).toBe("red");
    expect(tr.check(50_000)).toBeNull(); // compact: dropped below yellow → reset
    const again = tr.check(330_000);
    expect(again).not.toBeNull();
    expect(again!.level).toBe("yellow"); // re-armed
  });

  test("null / undefined / NaN token counts never warn", () => {
    const tr = createContextBudgetTracker(T);
    expect(tr.check(null)).toBeNull();
    expect(tr.check(undefined)).toBeNull();
    expect(tr.check(NaN)).toBeNull();
  });
});

describe("getThresholds env override", () => {
  test("defaults to 300k/400k/800k", () => {
    const prev = {
      y: process.env.CONTEXT_BUDGET_YELLOW,
      r: process.env.CONTEXT_BUDGET_RED,
      c: process.env.CONTEXT_BUDGET_CRITICAL,
    };
    delete process.env.CONTEXT_BUDGET_YELLOW;
    delete process.env.CONTEXT_BUDGET_RED;
    delete process.env.CONTEXT_BUDGET_CRITICAL;
    try {
      expect(getThresholds()).toEqual({
        yellow: 300_000,
        red: 400_000,
        critical: 800_000,
      });
    } finally {
      if (prev.y !== undefined) process.env.CONTEXT_BUDGET_YELLOW = prev.y;
      if (prev.r !== undefined) process.env.CONTEXT_BUDGET_RED = prev.r;
      if (prev.c !== undefined) process.env.CONTEXT_BUDGET_CRITICAL = prev.c;
    }
  });

  test("honours env overrides", () => {
    const prev = process.env.CONTEXT_BUDGET_YELLOW;
    process.env.CONTEXT_BUDGET_YELLOW = "120000";
    try {
      expect(getThresholds().yellow).toBe(120_000);
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_BUDGET_YELLOW;
      else process.env.CONTEXT_BUDGET_YELLOW = prev;
    }
  });
});
