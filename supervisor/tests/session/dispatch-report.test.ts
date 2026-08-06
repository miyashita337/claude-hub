import { describe, test, expect } from "bun:test";
import {
  formatDispatchReport,
  DISPATCH_REPORT_HEADING,
} from "../../src/session/dispatch-report";

/**
 * Epic corp #75 Phase 4 / #289, AC-1: the Dispatch 実行レポート format is a
 * machine-parsable contract that corp reconcile (corp #76) reads. These assert
 * the exact heading + `- key: value` shape so a drift is caught here, not by a
 * silently-broken reconcile.
 */
describe("formatDispatchReport", () => {
  test("renders heading + tokens/duration/exit lines when tokens are known", () => {
    const body = formatDispatchReport({
      tokens: 345,
      durationMs: 4200,
      exitCode: 0,
    });
    expect(body).toBe(
      [
        "## Dispatch 実行レポート",
        "",
        "- tokens: 345",
        "- duration_ms: 4200",
        "- exit_code: 0",
        "",
      ].join("\n"),
    );
  });

  test("heading constant matches the rendered heading (single source of truth)", () => {
    const body = formatDispatchReport({ tokens: 1, durationMs: 2, exitCode: 0 });
    expect(body.startsWith(DISPATCH_REPORT_HEADING + "\n")).toBe(true);
  });

  test("omits the tokens line entirely when tokens is null (no fabrication)", () => {
    const body = formatDispatchReport({
      tokens: null,
      durationMs: 1500,
      exitCode: 1,
    });
    expect(body).not.toContain("tokens:");
    expect(body).toContain("- duration_ms: 1500");
    expect(body).toContain("- exit_code: 1");
    // The heading and the two always-present lines survive.
    expect(body.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- duration_ms: 1500",
      "- exit_code: 1",
    ]);
  });

  test("emits tokens: 0 (a real value, distinct from unavailable)", () => {
    const body = formatDispatchReport({ tokens: 0, durationMs: 10, exitCode: 0 });
    expect(body).toContain("- tokens: 0");
  });

  test("renders exit_code: null verbatim for a killed/timed-out run", () => {
    const body = formatDispatchReport({
      tokens: null,
      durationMs: 7200000,
      exitCode: null,
    });
    expect(body).toContain("- exit_code: null");
  });

  test("keys use snake_case exactly (duration_ms, exit_code) for the parse contract", () => {
    const body = formatDispatchReport({ tokens: 7, durationMs: 3, exitCode: 9 });
    // Each contract line is a top-level `- key: value` bullet.
    for (const line of ["- tokens: 7", "- duration_ms: 3", "- exit_code: 9"]) {
      expect(body.split("\n")).toContain(line);
    }
  });

  // Issue #342: completion lines are ADDITIVE to the corp reconcile contract.
  describe("completion lines (#342)", () => {
    test("clean run emits the completion line, no warning", () => {
      const body = formatDispatchReport({
        tokens: 1,
        durationMs: 2,
        exitCode: 0,
        completion: "clean",
      });
      expect(body.split("\n")).toContain("- completion: clean");
      expect(body).not.toContain("⚠️");
    });

    test("pending run emits detail + a human warning", () => {
      const body = formatDispatchReport({
        tokens: 34602,
        durationMs: 2757370,
        exitCode: 0,
        completion: "pending",
        completionDetail: "未完了の背景タスク 1 件 (bas5ws1zh)",
      });
      expect(body.split("\n")).toContain("- completion: pending");
      expect(body).toContain("- completion_detail: 未完了の背景タスク 1 件 (bas5ws1zh)");
      expect(body).toContain("正常完了と確認できていません");
      expect(body).toContain("worktree は復旧用に保全");
    });

    test("unknown run also warns (fail-loud, not folded into clean)", () => {
      const body = formatDispatchReport({
        tokens: null,
        durationMs: 5,
        exitCode: 0,
        completion: "unknown",
        completionDetail: "transcript 検証不能 (ENOENT)",
      });
      expect(body.split("\n")).toContain("- completion: unknown");
      expect(body).toContain("正常完了と確認できていません");
    });

    test("omitting completion keeps the pre-#342 shape byte-identical", () => {
      const body = formatDispatchReport({ tokens: 7, durationMs: 3, exitCode: 9 });
      expect(body).not.toContain("completion");
      expect(body).toBe(
        "## Dispatch 実行レポート\n\n- tokens: 7\n- duration_ms: 3\n- exit_code: 9\n",
      );
    });
  });
});
