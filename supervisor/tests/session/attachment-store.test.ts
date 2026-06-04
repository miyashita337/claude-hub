import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { resolve, basename, dirname } from "path";
import {
  persistAttachments,
  materialsDir,
  sanitizeThreadId,
  sanitizeFilename,
} from "../../src/session/attachment-store";

describe("attachment-store (Issue #152)", () => {
  let root: string;
  let projectDir: string;
  let tmpDir: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "attach-store-"));
    projectDir = resolve(root, "project");
    tmpDir = resolve(root, "tmp");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeTmpFile(name: string, content: string): string {
    const p = resolve(tmpDir, name);
    writeFileSync(p, content);
    return p;
  }

  // Journey AC-1: all attachments saved to the persistent project path.
  test("copies every attachment into <projectDir>/.claude/discord-materials/<threadId>/", () => {
    const threadId = "1779450275804";
    const files = [1, 2, 3, 4].map((n) =>
      makeTmpFile(`${n}-IMG_479${n}.png`, `image-${n}`)
    );

    const persisted = persistAttachments(files, projectDir, threadId);

    const dir = materialsDir(projectDir, threadId);
    expect(persisted.length).toBe(4);
    for (const p of persisted) {
      expect(existsSync(p)).toBe(true);
      expect(dirname(p)).toBe(dir);
    }
    // Content is preserved (AC-3: Claude can Read the image content).
    expect(readFileSync(persisted[0]!, "utf8")).toBe("image-1");
  });

  // Journey AC-2: persisted path is NOT the tmp path, so the relay's 5-min
  // tmp cleanup (which targets the tmp list) leaves the persistent copy intact.
  test("returns persistent paths distinct from the tmp paths", () => {
    const threadId = "thread-abc";
    const tmp = makeTmpFile("99-shot.png", "x");

    const persisted = persistAttachments([tmp], projectDir, threadId)[0]!;

    expect(persisted).not.toBe(tmp);
    expect(persisted.startsWith(projectDir)).toBe(true);
  });

  test("empty input returns empty array", () => {
    expect(persistAttachments([], projectDir, "t")).toEqual([]);
  });

  // Defense: a hostile thread id cannot escape the materials dir.
  test("sanitizeThreadId strips path-traversal characters", () => {
    expect(sanitizeThreadId("../../etc")).toBe("etc");
    expect(sanitizeThreadId("a/b\\c")).toBe("abc");
    expect(sanitizeThreadId("1779450275804")).toBe("1779450275804");
    expect(sanitizeThreadId("")).toBe("_");
  });

  // Defense: a hostile filename cannot escape the materials dir.
  test("sanitizeFilename drops directory components and collapses ..", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a/b/c.png")).toBe("c.png");
    // A `..` run inside a name (no traversal) is collapsed but not rejected.
    expect(sanitizeFilename("foo..bar.png")).toBe("foo.bar.png");
    expect(sanitizeFilename("")).toBe("file");
  });

  test("traversal-laden threadId still writes inside the project dir", () => {
    const tmp = makeTmpFile("1-x.png", "x");
    const persisted = persistAttachments([tmp], projectDir, "../../../../tmp/evil")[0]!;
    expect(persisted.startsWith(projectDir)).toBe(true);
    expect(existsSync(persisted)).toBe(true);
  });

  // Fail-open: if the persistent dir can't be created (projectDir is a file),
  // the tmp path is returned so the relay still works this turn.
  test("falls back to tmp path when the materials dir cannot be created", () => {
    const fileAsProject = resolve(root, "not-a-dir");
    writeFileSync(fileAsProject, "i am a file");
    const tmp = makeTmpFile("1-x.png", "x");

    const persisted = persistAttachments([tmp], fileAsProject, "t")[0]!;

    expect(persisted).toBe(tmp);
  });

  // Fail-open per file: the dir is created fine, but one source file is missing,
  // so its copy throws — that file falls back to its (nonexistent) tmp path
  // while the other file still persists.
  test("falls back per-file when an individual copy fails", () => {
    const good = makeTmpFile("1-good.png", "ok");
    const missing = resolve(tmpDir, "2-missing.png"); // never written

    const [p1, p2] = persistAttachments([good, missing], projectDir, "t");

    expect(p1!.startsWith(projectDir)).toBe(true);
    expect(existsSync(p1!)).toBe(true);
    expect(p2).toBe(missing); // copy failed → tmp path returned
  });
});
