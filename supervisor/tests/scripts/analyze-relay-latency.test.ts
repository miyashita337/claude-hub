// Consumer tests for scripts/analyze-relay-latency.sh — the delivery-rate
// section added in Issue #223.
//
// This is the deterministic form of #223's 統合ジャーニーAC ("run the script →
// the Delivery 日次 section shows a rate% per day"): the script is fed a fixture
// JSONL and its stdout is asserted, so the AC is re-checked on every CI run
// instead of relying on a one-off manual look at the real log.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(
  import.meta.dir,
  "../../../scripts/analyze-relay-latency.sh"
);

async function run(logPath: string) {
  const proc = Bun.spawn(["bash", SCRIPT, logPath], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

/** One JSONL line in the shape latency-logger.ts writes. */
function record(
  timestamp: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    timestamp,
    session_id: "claude-test",
    load_avg_1m: 1.5,
    segments: { b: 10, c: 0, d_e_c: 900 },
    total_ms: 910,
    ...extra,
  });
}

describe("analyze-relay-latency.sh delivery rate (#223)", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "analyze-relay-latency-test-"));
    logPath = join(tmpDir, "relay-latency-log.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLog(lines: string[]): void {
    writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
  }

  test("reports overall attempts / delivered / dropped / rate", async () => {
    writeLog([
      record("2026-08-10T01:00:00.000Z", { delivered: true }),
      record("2026-08-10T02:00:00.000Z", { delivered: true }),
      record("2026-08-10T03:00:00.000Z", {
        delivered: false,
        error_segment: "d_e_c",
      }),
      record("2026-08-10T04:00:00.000Z", {
        delivered: false,
        error_segment: "b",
      }),
    ]);

    const { exitCode, stdout } = await run(logPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("=== Delivery (全期間) ===");
    expect(stdout).toContain(
      "attempts=4 delivered=2 dropped=2 rate=50%"
    );
  });

  test("breaks the rate down per day (the #223 journey AC)", async () => {
    writeLog([
      record("2026-08-10T01:00:00.000Z", { delivered: true }),
      record("2026-08-10T02:00:00.000Z", { delivered: true }),
      record("2026-08-10T03:00:00.000Z", { delivered: false }),
      record("2026-08-11T01:00:00.000Z", { delivered: true }),
      record("2026-08-11T02:00:00.000Z", { delivered: false }),
    ]);

    const { exitCode, stdout } = await run(logPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("=== Delivery (日次) ===");
    // Per-day lines are what a "before vs after the fix" comparison reads.
    expect(stdout).toContain(
      "2026-08-10 attempts=3 delivered=2 dropped=1 rate=66.7%"
    );
    expect(stdout).toContain(
      "2026-08-11 attempts=2 delivered=1 dropped=1 rate=50%"
    );
  });

  test("excludes pre-#223 records (no delivered field) from the rate", async () => {
    writeLog([
      // Legacy row: neither delivered nor dropped — counting it either way
      // would misreport the rate.
      record("2026-08-09T01:00:00.000Z"),
      record("2026-08-10T01:00:00.000Z", { delivered: true }),
      record("2026-08-10T02:00:00.000Z", { delivered: false }),
    ]);

    const { exitCode, stdout } = await run(logPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("attempts=2 delivered=1 dropped=1 rate=50%");
    expect(stdout).not.toContain("2026-08-09 attempts=");
  });

  test("says so plainly when no record carries delivery info yet", async () => {
    writeLog([record("2026-08-09T01:00:00.000Z")]);

    const { exitCode, stdout } = await run(logPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("attempts=0");
    // No divide-by-zero, no bogus 0% / 100% claim.
    expect(stdout).not.toContain("rate=");
  });
});
