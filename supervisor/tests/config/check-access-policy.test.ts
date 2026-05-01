import { describe, test, expect } from "bun:test";
import {
  checkAccessPolicyCounts,
  checkAccessPolicyTemplate,
} from "../../src/config/check-access-policy-core";

/**
 * Issue #100: verify CHANNEL_MAP and the Discord access policy stay in sync.
 *
 * The two checks have complementary responsibilities:
 *   - count check: catches drift in the live ~/.claude/.../access.json
 *   - template check: catches drift in the committed
 *     examples/access-policy.template.json (run in CI)
 */

describe("checkAccessPolicyCounts", () => {
  test("returns inSync when counts match (CHANNEL_MAP + 1 primary)", () => {
    const r = checkAccessPolicyCounts(11, 12);
    expect(r.inSync).toBe(true);
    expect(r.expected).toBe(12);
    expect(r.actual).toBe(12);
    expect(r.diff).toBe(0);
  });

  test("flags missing entries with negative diff", () => {
    const r = checkAccessPolicyCounts(11, 9);
    expect(r.inSync).toBe(false);
    expect(r.expected).toBe(12);
    expect(r.actual).toBe(9);
    expect(r.diff).toBe(-3);
  });

  test("flags extra entries with positive diff", () => {
    const r = checkAccessPolicyCounts(5, 8);
    expect(r.inSync).toBe(false);
    expect(r.diff).toBe(2);
  });

  test("respects custom primaryReserved (e.g. 0 if no claudeHubExit primary)", () => {
    const r = checkAccessPolicyCounts(5, 5, 0);
    expect(r.inSync).toBe(true);
    expect(r.expected).toBe(5);
  });

  test("handles edge case: empty CHANNEL_MAP and only the primary group", () => {
    const r = checkAccessPolicyCounts(0, 1);
    expect(r.inSync).toBe(true);
  });
});

describe("checkAccessPolicyTemplate", () => {
  const channelNames = ["team-salary", "convert-service", "video-qa"];

  test("returns inSync when template has same names + the primary marker", () => {
    const tplKeys = [
      "_claudeHubExitPrimary",
      "team-salary",
      "convert-service",
      "video-qa",
    ];
    const r = checkAccessPolicyTemplate(channelNames, tplKeys);
    expect(r.inSync).toBe(true);
    expect(r.missingFromTemplate).toEqual([]);
    expect(r.extraInTemplate).toEqual([]);
  });

  test("flags channels present in CHANNEL_MAP but missing from the template", () => {
    const tplKeys = ["_claudeHubExitPrimary", "team-salary"];
    const r = checkAccessPolicyTemplate(channelNames, tplKeys);
    expect(r.inSync).toBe(false);
    expect(r.missingFromTemplate).toEqual(["convert-service", "video-qa"]);
    expect(r.extraInTemplate).toEqual([]);
  });

  test("flags channels in the template but not in CHANNEL_MAP (stale)", () => {
    const tplKeys = [
      "_claudeHubExitPrimary",
      "team-salary",
      "convert-service",
      "video-qa",
      "deprecated-channel",
    ];
    const r = checkAccessPolicyTemplate(channelNames, tplKeys);
    expect(r.inSync).toBe(false);
    expect(r.missingFromTemplate).toEqual([]);
    expect(r.extraInTemplate).toEqual(["deprecated-channel"]);
  });

  test("flags both missing and extra simultaneously", () => {
    const tplKeys = ["_claudeHubExitPrimary", "team-salary", "old-channel"];
    const r = checkAccessPolicyTemplate(channelNames, tplKeys);
    expect(r.inSync).toBe(false);
    expect(r.missingFromTemplate).toEqual(["convert-service", "video-qa"]);
    expect(r.extraInTemplate).toEqual(["old-channel"]);
  });

  test("ignores the primary marker key by default", () => {
    // Even if CHANNEL_MAP doesn't include the primary marker, an entry for
    // it in the template is expected and should NOT be reported as extra.
    const tplKeys = ["_claudeHubExitPrimary", ...channelNames];
    const r = checkAccessPolicyTemplate(channelNames, tplKeys);
    expect(r.inSync).toBe(true);
  });

  test("custom primaryKey can be supplied", () => {
    const tplKeys = ["customPrimary", ...channelNames];
    const r = checkAccessPolicyTemplate(channelNames, tplKeys, "customPrimary");
    expect(r.inSync).toBe(true);
  });

  test("returns sorted lists for stable diff output", () => {
    const tplKeys = ["_claudeHubExitPrimary"]; // all 3 missing
    const r = checkAccessPolicyTemplate(
      ["video-qa", "team-salary", "convert-service"],
      tplKeys,
    );
    // Sorted alphabetically.
    expect(r.missingFromTemplate).toEqual([
      "convert-service",
      "team-salary",
      "video-qa",
    ]);
  });
});
