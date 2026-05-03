import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createLatencyTracker,
  recordRelayLatency,
  setLatencyLogPath,
  getLatencyLogPath,
  DEFAULT_LATENCY_LOG_PATH,
  SEGMENT_NAMES,
  type RelayLatencyRecord,
} from "../../src/session/latency-logger";

describe("latency-logger", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "latency-logger-test-"));
    logPath = join(tmpDir, "relay-latency-log.jsonl");
    setLatencyLogPath(logPath);
  });

  afterEach(() => {
    setLatencyLogPath(DEFAULT_LATENCY_LOG_PATH);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("DEFAULT_LATENCY_LOG_PATH points to ~/.claude/state/relay-latency-log.jsonl", () => {
    expect(DEFAULT_LATENCY_LOG_PATH).toContain(".claude");
    expect(DEFAULT_LATENCY_LOG_PATH).toContain("relay-latency-log.jsonl");
  });

  test("SEGMENT_NAMES has 5 entries (a, b, c, d_e_c, f)", () => {
    const keys = Object.keys(SEGMENT_NAMES).sort();
    expect(keys).toEqual(["a", "b", "c", "d_e_c", "f"]);
  });

  test("recordRelayLatency appends one JSON line per call", () => {
    const record: RelayLatencyRecord = {
      timestamp: "2026-05-03T10:00:00.000Z",
      session_id: "test-session-1",
      load_avg_1m: 1.5,
      segments: { b: 25, d_e_c: 1500 },
      total_ms: 1525,
    };
    recordRelayLatency(record);
    recordRelayLatency({ ...record, timestamp: "2026-05-03T10:00:10.000Z" });

    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.session_id).toBe("test-session-1");
    expect(parsed.segments.b).toBe(25);
    expect(parsed.segments.d_e_c).toBe(1500);
  });

  test("createLatencyTracker measures elapsed time per segment", async () => {
    const tracker = createLatencyTracker("session-x");
    tracker.markStart("b");
    await new Promise((r) => setTimeout(r, 30));
    tracker.markEnd("b");

    tracker.markStart("d_e_c");
    await new Promise((r) => setTimeout(r, 50));
    tracker.markEnd("d_e_c");

    const record = tracker.flush();

    expect(record.session_id).toBe("session-x");
    expect(record.segments.b).toBeGreaterThanOrEqual(25);
    expect(record.segments.b).toBeLessThan(200);
    expect(record.segments.d_e_c).toBeGreaterThanOrEqual(45);
    expect(record.segments.d_e_c).toBeLessThan(300);
    expect(typeof record.load_avg_1m).toBe("number");
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("markEnd without markStart is silently ignored (broken measurement guard)", () => {
    const tracker = createLatencyTracker("session-y");
    // markStart を呼ばずに markEnd → 該当 segment は記録されない (壊れた値にしない)
    tracker.markEnd("b");
    const record = tracker.flush();
    expect(record.segments.b).toBeUndefined();
  });

  test("setError sets error_segment in flushed record", () => {
    const tracker = createLatencyTracker("session-z");
    tracker.markStart("b");
    tracker.markEnd("b");
    tracker.setError("b");
    const record = tracker.flush();
    expect(record.error_segment).toBe("b");
  });

  test("getLatencyLogPath returns the currently configured path", () => {
    expect(getLatencyLogPath()).toBe(logPath);
  });

  test("flush writes the record to disk via recordRelayLatency", () => {
    const tracker = createLatencyTracker("session-flush");
    tracker.markStart("b");
    tracker.markEnd("b");
    tracker.flush();

    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.session_id).toBe("session-flush");
  });
});
