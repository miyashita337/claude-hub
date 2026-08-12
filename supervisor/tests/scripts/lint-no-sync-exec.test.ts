import { test, expect, describe } from "bun:test";
import { lintSource } from "../../scripts/lint-no-sync-exec";

/**
 * Issue #227 (PR-4, AC-3): the static gate must flag any synchronous
 * child-process exec (execSync / execFileSync / spawnSync) anywhere in a
 * `src/session/**` file, and must NOT false-positive on the safe shapes —
 * especially comments that merely mention execFileSync (several converted files
 * cite the migration), and the async execFile/spawn replacements.
 *
 * It must also fail if a sync exec is *reintroduced* (the regression direction):
 * the "flags a reintroduced execFileSync" case below is exactly that — it is the
 * shape a future refactor that reverts PR-4 would produce.
 */

describe("lint-no-sync-exec (#227 PR-4, AC-3)", () => {
  test("flags a top-level execFileSync (the reintroduction shape)", () => {
    const src = `import { execFileSync } from "child_process";
const out = execFileSync("git", ["status"], { stdio: "ignore" });`;
    const v = lintSource("src/session/worktree.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]!.callee).toBe("execFileSync");
    expect(v[0]!.line).toBe(2);
  });

  test("flags execSync and spawnSync (the full blocking set)", () => {
    const src = `execSync("ls");
spawnSync("tmux", ["kill-server"]);`;
    const v = lintSource("src/session/x.ts", src);
    expect(v.map((x) => x.callee).sort()).toEqual(["execSync", "spawnSync"]);
  });

  test("flags a sync exec nested inside a function / try block", () => {
    const src = `export function f() {
  try {
    execFileSync("pgrep", ["-x", "iTerm2"]);
  } catch {}
}`;
    const v = lintSource("src/session/iterm2.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]!.callee).toBe("execFileSync");
    expect(v[0]!.line).toBe(3);
  });

  test("flags property-access form (cp.execFileSync / Bun.spawnSync)", () => {
    const src = `cp.execFileSync("git", []);
Bun.spawnSync(["ls"]);`;
    const v = lintSource("src/session/x.ts", src);
    expect(v.map((x) => x.callee).sort()).toEqual(["execFileSync", "spawnSync"]);
  });

  test("does NOT flag the async execFile / promisify replacement", () => {
    const src = `import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
export async function f() {
  await execFileAsync("git", ["status"]);
}`;
    expect(lintSource("src/session/worktree.ts", src)).toHaveLength(0);
  });

  test("does NOT flag async spawn() (fire-and-forget)", () => {
    const src = `const p = spawn("osascript", ["-e", script], { stdio: "ignore" });
setTimeout(() => p.kill("SIGKILL"), 5000);`;
    expect(lintSource("src/session/iterm2.ts", src)).toHaveLength(0);
  });

  test("does NOT flag a comment that merely mentions execFileSync", () => {
    // This is the converted-file shape — AST ignores comments, grep would not.
    const src = `// Issue #227 (PR-4): async (not execFileSync) so a wedged tmux server
// cannot block the event loop.
await execFileAsync("tmux", []);`;
    expect(lintSource("src/session/tmux.ts", src)).toHaveLength(0);
  });

  test("does NOT flag a string literal that contains 'execFileSync'", () => {
    const src = `const msg = "do not use execFileSync here";`;
    expect(lintSource("src/session/x.ts", src)).toHaveLength(0);
  });

  // Same timing hazard, same reasoning as the sibling guard in
  // lint-blocking-in-timers.test.ts (Issue #398): parsing all 49 src/session/**
  // files with the TypeScript compiler is bounded CPU work that scales with the
  // tree, and under CPU contention on a busy developer machine it overran Bun's
  // 5000ms default even though it costs little on an uncontended runner. The
  // budget below is sized to swallow that contention rather than to bound the
  // work. Widen only this test; the fixture cases above keep the 5s default.
  test(
    "the production src/session/** tree is clean (regression guard)",
    async () => {
      const { Glob } = await import("bun");
      const files = [...new Glob("src/session/**/*.ts").scanSync(".")];
      expect(files.length).toBeGreaterThan(0);
      const all = [];
      for (const f of files) {
        const text = await Bun.file(f).text();
        all.push(...lintSource(f, text));
      }
      expect(all).toEqual([]);
    },
    120_000
  );
});
