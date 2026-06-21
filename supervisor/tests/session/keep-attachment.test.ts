import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import {
  keepAttachment,
  KeepError,
} from "../../src/session/keep-attachment";
import { gcAttachments } from "../../src/session/gc-attachments";

/**
 * Unit tests for /keep (Issue #193). A temp source dir stands in for
 * ATTACHMENT_DIR and a temp archive dir for ATTACHMENT_ARCHIVE_DIR, so the
 * move is exercised without touching the real ~/claude-hub tree.
 *
 * Journey AC mapping:
 *   - item 1: keep moves the file to the archive (notify handled by the command)
 *   - item 2: archived file survives GC; un-kept file is still TTL-swept
 *   - item 3: a missing filename is an explicit error, never a silent success
 */
describe("keepAttachment (#193)", () => {
  let src: string;
  let archive: string;

  beforeEach(() => {
    src = mkdtempSync(resolve(tmpdir(), "keep-src-"));
    archive = mkdtempSync(resolve(tmpdir(), "keep-archive-"));
  });

  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  });

  test("AC item 1: moves a file from source into the archive", () => {
    writeFileSync(resolve(src, "1-shot.png"), "data");

    const result = keepAttachment("1-shot.png", {
      sourceDir: src,
      archiveDir: archive,
    });

    expect(result.archivedPath).toBe(resolve(archive, "1-shot.png"));
    expect(existsSync(result.archivedPath)).toBe(true);
    // Removed from the swept source dir.
    expect(existsSync(resolve(src, "1-shot.png"))).toBe(false);
  });

  test("creates the archive directory if it does not yet exist", () => {
    const freshArchive = resolve(archive, "nested", "deep");
    writeFileSync(resolve(src, "a.png"), "x");

    const result = keepAttachment("a.png", {
      sourceDir: src,
      archiveDir: freshArchive,
    });

    expect(existsSync(result.archivedPath)).toBe(true);
  });

  test("AC item 3: a missing file throws KeepError (no silent success)", () => {
    expect(() =>
      keepAttachment("does-not-exist.png", { sourceDir: src, archiveDir: archive }),
    ).toThrow(KeepError);
    expect(() =>
      keepAttachment("does-not-exist.png", { sourceDir: src, archiveDir: archive }),
    ).toThrow(/見つかりません/);
  });

  test("an empty filename throws KeepError", () => {
    expect(() =>
      keepAttachment("   ", { sourceDir: src, archiveDir: archive }),
    ).toThrow(/必須/);
  });

  test("rejects path traversal / separators (cannot escape sourceDir)", () => {
    writeFileSync(resolve(src, "real.png"), "x");
    for (const bad of ["../real.png", "a/b.png", "/etc/passwd", "..", "."]) {
      expect(() =>
        keepAttachment(bad, { sourceDir: src, archiveDir: archive }),
      ).toThrow(KeepError);
    }
    // The legit file is untouched by the rejected attempts.
    expect(existsSync(resolve(src, "real.png"))).toBe(true);
  });

  test("a directory (not a file) is rejected", () => {
    mkdirSync(resolve(src, "subdir"));
    expect(() =>
      keepAttachment("subdir", { sourceDir: src, archiveDir: archive }),
    ).toThrow(/ファイルではありません/);
  });

  test("AC item 2: archived file survives GC; un-kept TTL-expired file is swept", () => {
    const NOW = 1_800_000_000_000;
    const DAY = 24 * 60 * 60 * 1000;

    // One file the user keeps, one stale file left in the swept dir.
    writeFileSync(resolve(src, "keep-me.png"), "x");
    const stale = resolve(src, "stale.png");
    writeFileSync(stale, "x");
    const staleSec = (NOW - 31 * DAY) / 1000;
    utimesSync(stale, staleSec, staleSec);

    const kept = keepAttachment("keep-me.png", {
      sourceDir: src,
      archiveDir: archive,
    });

    // GC sweeps the source dir only; the archive is a separate directory.
    const result = gcAttachments({ dir: src, now: NOW });

    expect(result.deleted).toContain(stale); // un-kept stale file removed
    expect(existsSync(kept.archivedPath)).toBe(true); // kept file untouched
    // GC never even sees the archived file (outside its swept dir).
    expect(result.deleted).not.toContain(kept.archivedPath);
  });
});
