#!/usr/bin/env bun
/**
 * Issue #227 (PR-4): block synchronous child-process exec calls anywhere under
 * `src/session/**`.
 *
 * The Supervisor is a single-process Bun event loop. A `*Sync` exec
 * (`execSync` / `execFileSync` / `spawnSync`) blocks the whole bot for the
 * duration of the child process — under tmux-server contention that stall
 * starves relay HTTP handling and surfaces as delayed / 5-min-timed-out Discord
 * delivery (the #222/#227 symptom). PR-1/2/3 migrated the hot paths (relay send,
 * the 5s dialog-watchdog poll, the core TmuxAdapter) to the async `execFile`;
 * PR-4 finishes the peripheral worktree / iTerm2 / tmux-config calls. This gate
 * keeps the whole `src/session/` tree sync-exec-free so a regression cannot
 * silently reintroduce a blocking call.
 *
 * AST-based (not grep): a comment that merely *mentions* `execFileSync` (several
 * files do, citing the migration) is not a CallExpression, so it is never
 * flagged — grep would false-positive on those. Only real call expressions are
 * reported. This is the file-scoped sibling of `lint-blocking-in-timers.ts`
 * (#27), which scopes the same blocking-call set to timer callbacks; here the
 * scope is "anywhere in src/session/**" instead of "inside a timer".
 *
 * Run: `bun scripts/lint-no-sync-exec.ts [files...]`
 * No args → scans `src/session/`+'/'+'**'+'/*.ts'. Exits 1 on any violation.
 */
import ts from "typescript";
import { readFileSync } from "fs";
import { resolve } from "path";

const BLOCKING_CALLS = new Set(["execSync", "execFileSync", "spawnSync"]);

export interface Violation {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
  callee: string;
}

/** Identifier `execSync(...)` or property access `cp.execSync(...)` / `Bun.spawnSync(...)`. */
function blockingCalleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr) && BLOCKING_CALLS.has(expr.text)) return expr.text;
  if (
    ts.isPropertyAccessExpression(expr) &&
    BLOCKING_CALLS.has(expr.name.text)
  ) {
    return expr.name.text;
  }
  return null;
}

export function lintSource(fileName: string, sourceText: string): Violation[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const violations: Violation[] = [];

  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = blockingCalleeName(node.expression);
      if (callee) {
        const { line, character } = sf.getLineAndCharacterOfPosition(
          node.getStart(sf)
        );
        violations.push({
          file: fileName,
          line: line + 1,
          column: character + 1,
          callee,
        });
      }
    }
    ts.forEachChild(node, scan);
  };

  scan(sf);
  return violations;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  // The supervisor root is this script's parent dir, so the default scan is
  // independent of the caller's cwd. Without this, running from the repo root
  // would glob a nonexistent `./src/session` → 0 files → a misleading "clean"
  // result.
  const root = resolve(import.meta.dir, "..");
  let entries: { display: string; abs: string }[];
  if (args.length > 0) {
    entries = args.map((a) => ({ display: a, abs: resolve(a) }));
  } else {
    const { Glob } = await import("bun");
    const matched = [...new Glob("src/session/**/*.ts").scanSync(root)];
    if (matched.length === 0) {
      console.error(
        `✖ lint-no-sync-exec: no source files found under ${root}/src/session — refusing to report clean.`
      );
      process.exit(1);
    }
    entries = matched.map((f) => ({ display: f, abs: resolve(root, f) }));
  }

  let total = 0;
  for (const { display, abs } of entries) {
    const text = readFileSync(abs, "utf8");
    for (const v of lintSource(display, text)) {
      console.error(
        `${v.file}:${v.line}:${v.column}  synchronous '${v.callee}(...)' in src/session/** — use the async execFile/spawn instead`
      );
      total++;
    }
  }

  if (total > 0) {
    console.error(
      `\n✖ ${total} synchronous-exec violation(s) (Issue #227 PR-4).\n` +
        `  A *Sync exec (execSync / execFileSync / spawnSync) blocks the single-process Supervisor\n` +
        `  event loop for the child's full duration — under tmux contention this starves relay HTTP\n` +
        `  handling and surfaces as delayed Discord delivery (#222/#227). Use the async execFile\n` +
        `  (promisify) or spawn (fire-and-forget) instead.`
    );
    process.exit(1);
  }
  console.log("✓ lint-no-sync-exec: no synchronous exec under src/session/**");
}
