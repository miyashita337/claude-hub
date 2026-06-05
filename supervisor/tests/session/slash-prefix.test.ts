import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isKnownSlashCommand,
  loadProjectCommands,
  looksLikeSlashCommand,
  stripLeadingSlash,
  _resetUserCommandCache,
} from "../../src/session/slash-prefix";

/**
 * Tests for Issue #86: typo'd slash commands like `/hanle-review` from a
 * Discord message previously hung Claude Code's Ink TUI in its slash-command
 * picker, blocking the per-thread relay queue until RELAY_TIMEOUT_MS.
 *
 * Issue #86 follow-up: known commands (built-ins + ~/.claude/commands/) are
 * passed through unmodified so legitimate slash commands keep working.
 *
 * Issue #155 (#86 follow-up A): the allowlist also consults project-scoped
 * commands (`<projectDir>/.claude/commands/*.md`) for the session's cwd, so a
 * project command like `/write-article` is no longer wrongly stripped.
 */

describe("looksLikeSlashCommand", () => {
  test.each([
    ["/handle-reviews", true],
    ["/handle-reviews 109", true],
    ["/hanle-review XXX", true],
    ["/sesssion-resume", true],
    ["/help", true],
    ["/help me", true],
    ["/h", true], // single letter command
    ["/abc_under-score123", true],
    ["/help\n続き", true], // \s newline boundary (PR #115 nitpick)
    ["/help\targ", true], // \s tab boundary (PR #115 nitpick)
  ])("matches `%s` → %s (slash-command shape)", (input, expected) => {
    expect(looksLikeSlashCommand(input)).toBe(expected);
  });

  test.each([
    ["/usr/bin/ls", false], // path: first token followed by `/`, not space
    ["/Users/x/foo", false], // path
    ["/", false], // bare slash, no letter
    ["//comment", false], // not letter after first `/`
    ["/123abc", false], // starts with digit
    ["", false], // empty
    ["普通のテキスト", false], // no slash
    ["何か /handle-reviews", false], // not at start
    ["/-leading-dash", false], // not letter immediately after slash
  ])("rejects `%s` → %s", (input, expected) => {
    expect(looksLikeSlashCommand(input)).toBe(expected);
  });
});

describe("stripLeadingSlash", () => {
  test("strips a slash-command prefix (the typo case)", () => {
    expect(stripLeadingSlash("/hanle-review XXX")).toBe("hanle-review XXX");
  });

  test("strips a slash-command prefix with no args", () => {
    expect(stripLeadingSlash("/handle-reviews")).toBe("handle-reviews");
  });

  test("preserves a path-like leading slash (`/usr/bin/ls`)", () => {
    expect(stripLeadingSlash("/usr/bin/ls")).toBe("/usr/bin/ls");
  });

  test("preserves a path-like leading slash (`/Users/x/foo`)", () => {
    expect(stripLeadingSlash("/Users/x/foo")).toBe("/Users/x/foo");
  });

  test("preserves arbitrary natural language", () => {
    expect(stripLeadingSlash("普通のテキスト")).toBe("普通のテキスト");
  });

  test("preserves a slash that is not at the very start", () => {
    expect(stripLeadingSlash("何か /handle-reviews")).toBe(
      "何か /handle-reviews"
    );
  });

  test("preserves bare slash (no letter follows)", () => {
    expect(stripLeadingSlash("/")).toBe("/");
  });

  test("preserves empty string", () => {
    expect(stripLeadingSlash("")).toBe("");
  });

  test("only strips a single leading slash, not deeper structure", () => {
    // The narrow regex ensures we don't strip into a path
    expect(stripLeadingSlash("/handle-reviews and /foo")).toBe(
      "handle-reviews and /foo",
    );
  });

  test("preserves trailing newline after stripping (PR #115 nitpick)", () => {
    expect(stripLeadingSlash("/help\n続き")).toBe("help\n続き");
  });

  test("preserves trailing tab after stripping (PR #115 nitpick)", () => {
    expect(stripLeadingSlash("/help\targ")).toBe("help\targ");
  });
});

describe("isKnownSlashCommand", () => {
  beforeEach(() => {
    _resetUserCommandCache();
  });

  const emptyLoader = () => new Set<string>();
  const customLoader = () =>
    new Set(["save-session", "handle-reviews", "pdca", "verify"]);

  test.each([
    "/help",
    "/help me",
    "/clear",
    "/compact arg",
    "/init",
    "/model",
    "/resume",
    "/agents",
    "/save",
  ])("recognises built-in `%s`", (input) => {
    expect(isKnownSlashCommand(input, emptyLoader)).toBe(true);
  });

  test.each([
    "/save-session",
    "/save-session foo bar",
    "/handle-reviews",
    "/pdca 42",
    "/verify",
  ])("recognises user-scope command `%s`", (input) => {
    expect(isKnownSlashCommand(input, customLoader)).toBe(true);
  });

  test.each([
    "/save-sesstion", // typo
    "/hanle-review", // typo
    "/totally-unknown",
    "/foo",
  ])("treats unknown `%s` as not-known (will be stripped)", (input) => {
    expect(isKnownSlashCommand(input, customLoader)).toBe(false);
  });

  test.each([
    "/usr/bin/ls", // path
    "", // empty
    "普通のテキスト", // no slash
    "何か /handle-reviews", // not at start
    "/", // bare slash
    "/123abc", // starts with digit
  ])("returns false for non-command shape `%s`", (input) => {
    expect(isKnownSlashCommand(input, customLoader)).toBe(false);
  });

  test("default loader reads ~/.claude/commands without throwing on missing dir", () => {
    // Set HOME to a non-existent path so the default loader hits ENOENT.
    const origHome = process.env.HOME;
    process.env.HOME = "/tmp/__claude_hub_no_such_dir__";
    try {
      _resetUserCommandCache();
      // Built-ins still recognised even with no user dir.
      expect(isKnownSlashCommand("/help")).toBe(true);
      // Unknown still rejected.
      expect(isKnownSlashCommand("/totally-unknown")).toBe(false);
    } finally {
      if (origHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = origHome;
      }
      _resetUserCommandCache();
    }
  });

  test("default loader reads real ~/.claude/commands when present", () => {
    _resetUserCommandCache();
    // Smoke test: this exercises the real readdirSync path. We don't assert
    // a specific command name (machine-dependent), only that the function
    // returns a boolean without throwing.
    const result = isKnownSlashCommand("/totally-unknown-XYZ");
    expect(typeof result).toBe("boolean");
  });

  // Issue #155: project-scoped commands (the injected projectLoader path).
  describe("project-scoped commands (Issue #155)", () => {
    const projectLoader = () => new Set(["write-article", "draft-article"]);

    test("AC-1: recognises a project command via projectLoader", () => {
      // built-in + user-global are empty here; only the project loader knows it
      expect(
        isKnownSlashCommand("/write-article", emptyLoader, projectLoader),
      ).toBe(true);
      expect(
        isKnownSlashCommand("/write-article 199", emptyLoader, projectLoader),
      ).toBe(true);
    });

    test("AC-3: a typo of a project command is still unknown (stripped)", () => {
      expect(
        isKnownSlashCommand("/wrtie-article", emptyLoader, projectLoader),
      ).toBe(false);
    });

    test("AC-2: built-ins and user-global still recognised alongside project loader", () => {
      // built-in
      expect(isKnownSlashCommand("/help", emptyLoader, projectLoader)).toBe(
        true,
      );
      // user-global (customLoader) command unaffected by project loader
      expect(
        isKnownSlashCommand("/save-session", customLoader, projectLoader),
      ).toBe(true);
    });

    test("absent projectLoader preserves prior built-in + user-global behaviour", () => {
      // No third arg → empty project loader default. Project-only command is
      // unknown; built-ins/user-global unchanged.
      expect(isKnownSlashCommand("/write-article", customLoader)).toBe(false);
      expect(isKnownSlashCommand("/pdca", customLoader)).toBe(true);
    });
  });
});

describe("loadProjectCommands (Issue #155)", () => {
  let tmpDirs: string[] = [];

  function makeProject(commands: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "claude-hub-proj-"));
    tmpDirs.push(root);
    const cmdDir = join(root, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    for (const name of commands) {
      writeFileSync(join(cmdDir, `${name}.md`), `# ${name}\n`);
    }
    return root;
  }

  beforeEach(() => {
    _resetUserCommandCache(); // also clears the per-project cache
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  test("reads <projectDir>/.claude/commands/*.md into a name set", () => {
    const proj = makeProject(["write-article", "draft-article"]);
    const set = loadProjectCommands(proj);
    expect(set.has("write-article")).toBe(true);
    expect(set.has("draft-article")).toBe(true);
    expect(set.has("nonexistent")).toBe(false);
  });

  test("end-to-end: isKnownSlashCommand resolves a real project command", () => {
    const proj = makeProject(["write-article"]);
    expect(
      isKnownSlashCommand("/write-article 199", () => new Set(), () =>
        loadProjectCommands(proj),
      ),
    ).toBe(true);
    // typo still unknown
    expect(
      isKnownSlashCommand("/wrtie-article", () => new Set(), () =>
        loadProjectCommands(proj),
      ),
    ).toBe(false);
  });

  test("caches are isolated per projectDir (no cross-project leakage)", () => {
    const projA = makeProject(["alpha-cmd"]);
    const projB = makeProject(["beta-cmd"]);
    const setA = loadProjectCommands(projA);
    const setB = loadProjectCommands(projB);
    expect(setA.has("alpha-cmd")).toBe(true);
    expect(setA.has("beta-cmd")).toBe(false);
    expect(setB.has("beta-cmd")).toBe(true);
    expect(setB.has("alpha-cmd")).toBe(false);
  });

  test("missing project command dir returns empty set without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-hub-noproj-"));
    tmpDirs.push(root);
    // No .claude/commands dir created → ENOENT path.
    const set = loadProjectCommands(root);
    expect(set.size).toBe(0);
  });

  test("ignores non-.md and .bak.md files", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-hub-mixed-"));
    tmpDirs.push(root);
    const cmdDir = join(root, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "real-cmd.md"), "# real\n");
    writeFileSync(join(cmdDir, "notes.txt"), "not a command\n");
    writeFileSync(join(cmdDir, "old-cmd.bak.md"), "# backup\n");
    const set = loadProjectCommands(root);
    expect(set.has("real-cmd")).toBe(true);
    expect(set.has("notes")).toBe(false);
    expect(set.has("old-cmd.bak")).toBe(false);
    expect(set.has("old-cmd")).toBe(false);
  });

  test("returns cached set within the TTL window after dir changes", () => {
    const proj = makeProject(["first-cmd"]);
    const first = loadProjectCommands(proj);
    expect(first.has("first-cmd")).toBe(true);
    // Add a new command on disk; within TTL the cached set is returned
    // unchanged (proves caching is active and per-project).
    writeFileSync(
      join(proj, ".claude", "commands", "second-cmd.md"),
      "# second\n",
    );
    const second = loadProjectCommands(proj);
    expect(second.has("second-cmd")).toBe(false);
    expect(second).toBe(first); // same cached reference
  });
});
