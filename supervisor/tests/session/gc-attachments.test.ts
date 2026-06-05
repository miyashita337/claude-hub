import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "fs";
import * as fs from "fs";
import { resolve, isAbsolute } from "path";
import { tmpdir } from "os";
import {
  gcAttachments,
  ATTACHMENT_MAX_AGE_MS,
  ATTACHMENT_DIR,
} from "../../src/session/gc-attachments";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed reference "now" for determinism

/** Create a file and back-date its mtime to `ageMs` before NOW. */
function makeFile(dir: string, name: string, ageMs: number): string {
  const p = resolve(dir, name);
  writeFileSync(p, "x");
  const mtimeSec = (NOW - ageMs) / 1000;
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

describe("gcAttachments", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "gc-attach-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("deletes files older than maxAgeMs", () => {
    const old = makeFile(dir, "old.png", 31 * DAY_MS);
    const result = gcAttachments({ dir, maxAgeMs: ATTACHMENT_MAX_AGE_MS, now: NOW });
    expect(result.deleted).toContain(old);
    expect(existsSync(old)).toBe(false);
  });

  test("keeps files younger than maxAgeMs (cross-session persistence)", () => {
    const fresh = makeFile(dir, "fresh.png", 1 * DAY_MS);
    const result = gcAttachments({ dir, maxAgeMs: ATTACHMENT_MAX_AGE_MS, now: NOW });
    expect(result.kept).toBe(1);
    expect(result.deleted).not.toContain(fresh);
    expect(existsSync(fresh)).toBe(true);
  });

  test("boundary: exactly maxAgeMs old is kept (strictly older is deleted)", () => {
    const exact = makeFile(dir, "exact.png", ATTACHMENT_MAX_AGE_MS);
    const result = gcAttachments({ dir, maxAgeMs: ATTACHMENT_MAX_AGE_MS, now: NOW });
    // mtime === cutoff is not "< cutoff", so it is retained.
    expect(existsSync(exact)).toBe(true);
    expect(result.kept).toBe(1);
  });

  test("mixed set: deletes only the old ones", () => {
    makeFile(dir, "a-old.png", 40 * DAY_MS);
    makeFile(dir, "b-old.png", 35 * DAY_MS);
    makeFile(dir, "c-fresh.png", 2 * DAY_MS);
    const result = gcAttachments({ dir, maxAgeMs: ATTACHMENT_MAX_AGE_MS, now: NOW });
    expect(result.deleted.length).toBe(2);
    expect(result.kept).toBe(1);
  });

  test("logs a warning for each deletion (silent-failure guard, AC-4)", () => {
    makeFile(dir, "old.png", 31 * DAY_MS);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      gcAttachments({ dir, maxAgeMs: ATTACHMENT_MAX_AGE_MS, now: NOW });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("deleted");
    } finally {
      warn.mockRestore();
    }
  });

  test("missing directory is a no-op (no throw)", () => {
    const missing = resolve(dir, "does-not-exist");
    const result = gcAttachments({ dir: missing, maxAgeMs: ATTACHMENT_MAX_AGE_MS, now: NOW });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toBe(0);
  });

  test("ignores subdirectories (only sweeps files)", () => {
    mkdirSync(resolve(dir, "subdir"));
    const result = gcAttachments({ dir, maxAgeMs: ATTACHMENT_MAX_AGE_MS, now: NOW });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toBe(0);
  });

  test("default ATTACHMENT_DIR is an absolute tmp/attachments path; default age is 30d", () => {
    expect(isAbsolute(ATTACHMENT_DIR)).toBe(true);
    expect(ATTACHMENT_DIR.endsWith("claude-hub/tmp/attachments")).toBe(true);
    expect(ATTACHMENT_MAX_AGE_MS).toBe(30 * DAY_MS);
  });

  test("delete failure is logged and does not abort the sweep", () => {
    makeFile(dir, "old-a.png", 31 * DAY_MS);
    makeFile(dir, "old-b.png", 31 * DAY_MS);
    const unlink = spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw new Error("EPERM: simulated");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = gcAttachments({ dir, maxAgeMs: ATTACHMENT_MAX_AGE_MS, now: NOW });
      // Both deletions failed → nothing recorded as deleted, sweep still completed.
      expect(result.deleted).toEqual([]);
      // Each failure emits a "failed to delete" warning (silent-failure guard).
      const failedLogs = warn.mock.calls.filter((c) =>
        String(c[0]).includes("failed to delete")
      );
      expect(failedLogs.length).toBe(2);
    } finally {
      warn.mockRestore();
      unlink.mockRestore();
    }
  });
});
