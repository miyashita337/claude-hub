import { test, expect, describe } from "bun:test";
import { lintSource } from "../../scripts/lint-blocking-in-timers";

/**
 * Issue #27 (Task 3, AC-3): the lint must block an intentional violation
 * (a synchronous exec inside a timer callback) and must NOT false-positive on
 * the safe shapes — especially comments that merely mention execSync, which
 * manager.ts actually contains.
 */

describe("lint-blocking-in-timers (#27 AC-3)", () => {
  test("flags execSync inside a setTimeout arrow callback", () => {
    const src = `import { execSync } from "child_process";
setTimeout(() => {
  execSync("sleep 1");
}, 100);`;
    const v = lintSource("fixture.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]!.callee).toBe("execSync");
    expect(v[0]!.line).toBe(3);
  });

  test("flags execFileSync inside a setInterval function expression", () => {
    const src = `setInterval(function () {
  execFileSync("tmux", ["kill-server"]);
}, 1000);`;
    const v = lintSource("fixture.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]!.callee).toBe("execFileSync");
  });

  test("flags property-access form (cp.spawnSync / Bun.spawnSync)", () => {
    const src = `setTimeout(() => {
  cp.spawnSync("ls", []);
}, 0);
setInterval(() => { Bun.spawnSync(["ls"]); }, 5);`;
    const v = lintSource("fixture.ts", src);
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.callee).sort()).toEqual(["spawnSync", "spawnSync"]);
  });

  test("does NOT flag a top-level (non-timer) execSync", () => {
    const src = `execSync("git status");`;
    expect(lintSource("fixture.ts", src)).toHaveLength(0);
  });

  test("does NOT flag a comment that merely mentions execSync inside a timer", () => {
    // This is the manager.ts shape — AST ignores comments, grep would not.
    const src = `setTimeout(() => {
  // previously this used execSync("sleep 0.5") which blocked the loop
  doAsyncThing();
}, 100);`;
    expect(lintSource("fixture.ts", src)).toHaveLength(0);
  });

  test("does NOT flag async spawn() inside a timer (the correct pattern)", () => {
    const src = `setTimeout(() => {
  const p = spawn("osascript", ["-e", script], { stdio: "ignore" });
  setTimeout(() => p.kill("SIGKILL"), 5000);
}, 100);`;
    expect(lintSource("fixture.ts", src)).toHaveLength(0);
  });

  test("does NOT follow a named-reference callback (documented limitation)", () => {
    const src = `function doWork() { execSync("x"); }
setTimeout(doWork, 100);`;
    // doWork's own body is top-level (not inside the inline callback), so the
    // execSync there is not attributed to the timer.
    expect(lintSource("fixture.ts", src)).toHaveLength(0);
  });

  test("does NOT flag a blocking call used to compute the delay argument", () => {
    const src = `setTimeout(fn, execSync("echo 100"));`;
    expect(lintSource("fixture.ts", src)).toHaveLength(0);
  });

  test("reports each blocking call once even when timers are nested", () => {
    const src = `setInterval(() => {
  setTimeout(() => {
    execSync("a");
  }, 1);
}, 10);`;
    const v = lintSource("fixture.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]!.callee).toBe("execSync");
  });

  test("the production source tree is clean (regression guard)", async () => {
    const { Glob } = await import("bun");
    const files = [...new Glob("src/**/*.ts").scanSync(".")];
    expect(files.length).toBeGreaterThan(0);
    const all = [];
    for (const f of files) {
      const text = await Bun.file(f).text();
      all.push(...lintSource(f, text));
    }
    expect(all).toEqual([]);
  });
});
