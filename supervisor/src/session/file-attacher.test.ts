import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { extractFilePaths, collectAttachableFiles } from "./file-attacher";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "fa-"));
  mkdirSync(resolve(tmp, "output/articles"), { recursive: true });
  writeFileSync(resolve(tmp, "output/articles/note.md"), "# hi");
  writeFileSync(resolve(tmp, "output/articles/big.md"), Buffer.alloc(9 * 1024 * 1024));
  writeFileSync(resolve(tmp, "result.json"), '{"a":1}');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("extractFilePaths finds relative md path", () => {
  const paths = extractFilePaths("生成しました: output/articles/note.md を確認してください。");
  expect(paths).toContain("output/articles/note.md");
});

test("extractFilePaths finds multiple extensions and dedupes", () => {
  const t = "files: ./a.json, ./a.json, /tmp/b.csv, image.png";
  const paths = extractFilePaths(t);
  expect(paths).toContain("./a.json");
  expect(paths).toContain("/tmp/b.csv");
  expect(paths).toContain("image.png");
  expect(paths.filter((p) => p === "./a.json").length).toBe(1);
});

test("extractFilePaths ignores unknown extensions", () => {
  const paths = extractFilePaths("binary blob at foo.exe and bar.bin");
  expect(paths.length).toBe(0);
});

test("extractFilePaths handles Japanese filenames", () => {
  const paths = extractFilePaths("output/articles/2026-04-07_【速報解説】記事.md ができました");
  expect(paths.some((p) => p.endsWith(".md"))).toBe(true);
});

test("collectAttachableFiles resolves relative paths and returns existing files", () => {
  const { files } = collectAttachableFiles(
    ["output/articles/note.md", "result.json", "missing.md"],
    tmp
  );
  expect(files.length).toBe(2);
  expect(files.map((f) => f.displayName).sort()).toEqual(["note.md", "result.json"]);
});

test("collectAttachableFiles filters oversize files with warning", () => {
  const { files, oversizeWarnings } = collectAttachableFiles(
    ["output/articles/big.md", "output/articles/note.md"],
    tmp
  );
  expect(files.map((f) => f.displayName)).toEqual(["note.md"]);
  expect(oversizeWarnings.length).toBe(1);
  expect(oversizeWarnings[0]).toContain("big.md");
});

test("collectAttachableFiles tolerates non-existent paths", () => {
  const { files, oversizeWarnings } = collectAttachableFiles(
    ["nope/a.md", "nope/b.json"],
    tmp
  );
  expect(files).toEqual([]);
  expect(oversizeWarnings).toEqual([]);
});

test("collectAttachableFiles caps at 10 files", () => {
  const dir = resolve(tmp, "many");
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < 15; i++) {
    const p = resolve(dir, `f${i}.txt`);
    writeFileSync(p, "x");
    paths.push(p);
  }
  const { files } = collectAttachableFiles(paths, tmp);
  expect(files.length).toBe(10);
});
