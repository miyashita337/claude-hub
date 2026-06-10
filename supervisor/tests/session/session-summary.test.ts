import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractWorktree,
  extractSummaryText,
  isPathUnder,
  selectSummaryFromCandidates,
  findPreviousSessionSummary,
  formatSummaryMessage,
  type SummaryCandidate,
} from "../../src/session/session-summary";

// Issue #141: the Supervisor must surface the previous-session summary into the
// Discord thread on start/resume, because the ECC SessionStart hook only injects
// it into Claude's invisible context (never the relayed pane).

const ECC_BLOCK = [
  "# Session: 2026-06-10",
  "**Project:** agent-deadbeef",
  "**Worktree:** /Users/x/team_salary/.claude/worktrees/feat-foo",
  "",
  "---",
  "<!-- ECC:SUMMARY:START -->",
  "## Session Summary",
  "### Tasks",
  "- note 下書きを作成",
  "<!-- ECC:SUMMARY:END -->",
  "### Notes",
  "trailing noise that must NOT be included",
].join("\n");

describe("extractWorktree", () => {
  test("reads the **Worktree:** header", () => {
    expect(extractWorktree(ECC_BLOCK)).toBe(
      "/Users/x/team_salary/.claude/worktrees/feat-foo"
    );
  });

  test("returns empty string when absent", () => {
    expect(extractWorktree("# Session\n**Project:** x")).toBe("");
  });
});

describe("extractSummaryText", () => {
  test("extracts ONLY the ECC:SUMMARY block (excludes header + trailing)", () => {
    const text = extractSummaryText(ECC_BLOCK);
    expect(text).toContain("## Session Summary");
    expect(text).toContain("note 下書きを作成");
    expect(text).not.toContain("**Project:**");
    expect(text).not.toContain("trailing noise");
  });

  test("falls back to whole trimmed content when no ECC markers", () => {
    const raw = "  # Session narrative\n**Worktree:** /a/b\nbody  ";
    expect(extractSummaryText(raw)).toBe(raw.trim());
  });

  test("empty when markers are malformed (END before START)", () => {
    // END before START → no valid block → falls back to whole content
    const raw = "<!-- ECC:SUMMARY:END -->x<!-- ECC:SUMMARY:START -->";
    // fallback returns the whole trimmed content (non-empty here)
    expect(extractSummaryText(raw)).toBe(raw.trim());
  });
});

describe("isPathUnder", () => {
  test("exact match", () => {
    expect(isPathUnder("/a/b", "/a/b")).toBe(true);
  });
  test("nested under at boundary", () => {
    expect(isPathUnder("/a/b/.claude/worktrees/x", "/a/b")).toBe(true);
  });
  test("rejects sibling prefix (no false boundary match)", () => {
    expect(isPathUnder("/a/b-other", "/a/b")).toBe(false);
  });
  test("rejects unrelated", () => {
    expect(isPathUnder("/a/c", "/a/b")).toBe(false);
  });
  test("empty parent never matches", () => {
    expect(isPathUnder("/a/b", "")).toBe(false);
  });
});

describe("selectSummaryFromCandidates", () => {
  const mk = (worktree: string, mtimeMs: number, summary = "S"): SummaryCandidate => ({
    path: `/tmp/${mtimeMs}-session.tmp`,
    mtimeMs,
    content: [
      "**Worktree:** " + worktree,
      "<!-- ECC:SUMMARY:START -->",
      summary,
      "<!-- ECC:SUMMARY:END -->",
    ].join("\n"),
  });

  test("exact worktree match wins and reports reason", () => {
    const r = selectSummaryFromCandidates([mk("/repo/wt", 100)], {
      projectDir: "/repo/wt",
      repoRoot: "/repo",
    });
    expect(r?.matchReason).toBe("worktree-exact");
    expect(r?.text).toBe("S");
  });

  test("nested worktree (new session, no exact) matches by repo root", () => {
    const r = selectSummaryFromCandidates(
      [mk("/repo/.claude/worktrees/old", 100)],
      { projectDir: "/repo/.claude/worktrees/brand-new", repoRoot: "/repo" }
    );
    expect(r?.matchReason).toBe("project-nested");
  });

  test("picks the NEWEST matching candidate", () => {
    const r = selectSummaryFromCandidates(
      [mk("/repo/a", 100, "OLD"), mk("/repo/b", 200, "NEW")],
      { projectDir: "/repo/x", repoRoot: "/repo" }
    );
    expect(r?.text).toBe("NEW");
  });

  test("ignores sessions from other projects", () => {
    const r = selectSummaryFromCandidates([mk("/other/wt", 100)], {
      projectDir: "/repo/wt",
      repoRoot: "/repo",
    });
    expect(r).toBeNull();
  });

  test("returns null on empty candidate list", () => {
    expect(
      selectSummaryFromCandidates([], { projectDir: "/r", repoRoot: "/r" })
    ).toBeNull();
  });

  test("skips candidates without a Worktree header", () => {
    const noWt: SummaryCandidate = {
      path: "/tmp/x-session.tmp",
      mtimeMs: 999,
      content: "**Project:** p\n<!-- ECC:SUMMARY:START -->\nS\n<!-- ECC:SUMMARY:END -->",
    };
    expect(
      selectSummaryFromCandidates([noWt], { projectDir: "/r", repoRoot: "/r" })
    ).toBeNull();
  });
});

describe("findPreviousSessionSummary (fs)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-summary-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeSession = (name: string, worktree: string, ageDays = 0) => {
    const p = join(dir, name);
    writeFileSync(
      p,
      [
        "**Worktree:** " + worktree,
        "<!-- ECC:SUMMARY:START -->",
        "summary for " + worktree,
        "<!-- ECC:SUMMARY:END -->",
      ].join("\n")
    );
    if (ageDays > 0) {
      const t = (Date.now() - ageDays * 86400_000) / 1000;
      utimesSync(p, t, t);
    }
    return p;
  };

  test("finds an exact-worktree match from disk", () => {
    writeSession("a-session.tmp", "/repo/wt");
    const r = findPreviousSessionSummary({
      projectDir: "/repo/wt",
      repoRoot: "/repo",
      searchDirs: [dir],
    });
    expect(r?.text).toContain("summary for /repo/wt");
  });

  test("ignores non *-session.tmp files", () => {
    writeFileSync(join(dir, "notes.md"), "**Worktree:** /repo/wt\nx");
    const r = findPreviousSessionSummary({
      projectDir: "/repo/wt",
      repoRoot: "/repo",
      searchDirs: [dir],
    });
    expect(r).toBeNull();
  });

  test("excludes sessions older than maxAgeDays", () => {
    writeSession("old-session.tmp", "/repo/wt", 40);
    const r = findPreviousSessionSummary({
      projectDir: "/repo/wt",
      repoRoot: "/repo",
      searchDirs: [dir],
      maxAgeDays: 30,
    });
    expect(r).toBeNull();
  });

  test("missing directory yields null, not a throw", () => {
    const r = findPreviousSessionSummary({
      projectDir: "/repo/wt",
      repoRoot: "/repo",
      searchDirs: [join(dir, "does-not-exist")],
    });
    expect(r).toBeNull();
  });
});

describe("formatSummaryMessage", () => {
  test("prefixes a header", () => {
    const msg = formatSummaryMessage({
      text: "hello",
      sourceFile: "/x",
      matchReason: "worktree-exact",
    });
    expect(msg).toContain("前回セッションの要約");
    expect(msg).toContain("hello");
  });

  test("truncates over-long bodies under the Discord limit", () => {
    const msg = formatSummaryMessage({
      text: "あ".repeat(5000),
      sourceFile: "/x",
      matchReason: "worktree-exact",
    });
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg).toContain("以下省略");
  });
});
