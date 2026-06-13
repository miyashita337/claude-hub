import { test, expect, describe } from "bun:test";
import { createSelfHealer } from "../../src/session/self-heal";

/**
 * Unit tests for the self-heal planner (Issue #206). The planner is a per-
 * session state machine fed band-crossing levels (from the context-budget
 * tracker) and returns the auto-action to take.
 *
 * Journey AC mapping:
 *   - item 1: red → "compact"
 *   - item 2: a rebounding context hits the cap → "cap-reached" (no infinite loop)
 *   - item 3: critical → "notify" (auto-restart execution deferred to follow-up)
 */
describe("createSelfHealer (#206)", () => {
  test("yellow → none (notify only, no auto-action consumed)", () => {
    const h = createSelfHealer({ maxAutoActions: 3 });
    const d = h.decide("yellow");
    expect(d.action).toBe("none");
    expect(d.actionCount).toBe(0);
  });

  test("AC item 1: red → compact, increments the auto-action count", () => {
    const h = createSelfHealer({ maxAutoActions: 3 });
    const d = h.decide("red");
    expect(d.action).toBe("compact");
    expect(d.actionCount).toBe(1);
    expect(d.cap).toBe(3);
  });

  test("AC item 3: critical → notify (restart execution deferred), no count consumed", () => {
    const h = createSelfHealer({ maxAutoActions: 3 });
    const d = h.decide("critical");
    expect(d.action).toBe("notify");
    // critical does not consume an auto-action — the cap gates compacts only.
    expect(d.actionCount).toBe(0);
  });

  test("AC item 2: repeated red rebounds hit the cap, then stop auto-acting", () => {
    const h = createSelfHealer({ maxAutoActions: 2 });
    expect(h.decide("red").action).toBe("compact"); // 1
    expect(h.decide("red").action).toBe("compact"); // 2 (cap)
    const capped = h.decide("red"); // 3rd would exceed → cap-reached
    expect(capped.action).toBe("cap-reached");
    expect(capped.actionCount).toBe(2); // not incremented past the cap
    // Stays capped on subsequent reds (no infinite loop).
    expect(h.decide("red").action).toBe("cap-reached");
  });

  test("critical after the cap is reached → cap-reached (no further auto-action)", () => {
    const h = createSelfHealer({ maxAutoActions: 1 });
    expect(h.decide("red").action).toBe("compact"); // consumes the only slot
    // Now at cap: even a critical escalation reports cap-reached, prompting
    // manual intervention rather than silently doing nothing.
    expect(h.decide("critical").action).toBe("cap-reached");
  });

  test("yellow never consumes the cap even when repeated", () => {
    const h = createSelfHealer({ maxAutoActions: 1 });
    h.decide("yellow");
    h.decide("yellow");
    // The single slot is still available for a real (red) action.
    expect(h.decide("red").action).toBe("compact");
  });

  test("default cap is applied when maxAutoActions is omitted", () => {
    const h = createSelfHealer();
    // Default cap is 3 (env CONTEXT_SELF_HEAL_MAX_ACTIONS overridable).
    expect(h.decide("red").cap).toBe(3);
  });
});
