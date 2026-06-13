#!/usr/bin/env bun
/**
 * Issue #27 (Task 3): block synchronous child-process calls placed *inside* a
 * `setTimeout` / `setInterval` callback.
 *
 * The Supervisor is a single-process Bun event loop. A `*Sync` exec inside a
 * timer callback freezes the whole bot every time the timer fires — this is the
 * exact failure class manager.ts moved away from (it replaced `execSync("sleep")`
 * with non-blocking waits; see manager.ts:472/721/814). Use `spawn()` (async)
 * inside timer callbacks instead.
 *
 * AST-based (not grep): a comment that merely *mentions* `execSync("sleep")`
 * (manager.ts has several) is not a CallExpression, so it is never flagged —
 * grep would false-positive on those. Only real calls reachable from a timer's
 * inline callback are reported.
 *
 * Limitation: only the timer's *inline* callback subtree is inspected. A timer
 * whose callback is a named reference (`setTimeout(doWork, 100)`) is not
 * followed — the dangerous, common shape the issue targets is the inline one.
 *
 * Run: `bun scripts/lint-blocking-in-timers.ts [files...]`
 * No args → scans `src/`+'/'+'**'+'/*.ts'. Exits 1 on any violation.
 */
import ts from "typescript";
import { readFileSync } from "fs";
import { resolve } from "path";

const BLOCKING_CALLS = new Set(["execSync", "execFileSync", "spawnSync"]);
const TIMER_FNS = new Set(["setTimeout", "setInterval"]);

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

/** `setTimeout(...)` / `setInterval(...)`, bare or via `globalThis.setTimeout(...)`. */
function isTimerCall(node: ts.CallExpression): boolean {
  const e = node.expression;
  if (ts.isIdentifier(e)) return TIMER_FNS.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return TIMER_FNS.has(e.name.text);
  return false;
}

export function lintSource(fileName: string, sourceText: string): Violation[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const violations: Violation[] = [];

  const scan = (node: ts.Node, insideTimer: boolean): void => {
    if (ts.isCallExpression(node)) {
      if (insideTimer) {
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

      if (isTimerCall(node)) {
        // setTimeout/setInterval take the callback as arg[0]; arg[1+] are the
        // delay and optional params passed *into* the callback (not executed in
        // the timer body), so only arg[0]'s inline body is treated as in-timer.
        const [callback, ...rest] = node.arguments;
        // The callee and the non-callback args keep the current context (a
        // blocking call computing the *delay* runs at schedule time, not per
        // tick, so it is out of scope here).
        scan(node.expression, insideTimer);
        for (const arg of rest) scan(arg, insideTimer);
        if (callback) {
          const inlineCallback =
            ts.isArrowFunction(callback) || ts.isFunctionExpression(callback);
          scan(callback, inlineCallback ? true : insideTimer);
        }
        return; // children handled explicitly
      }
    }

    ts.forEachChild(node, (child) => scan(child, insideTimer));
  };

  scan(sf, false);
  return violations;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  // The supervisor root is this script's parent dir, so the default scan is
  // independent of the caller's cwd. Without this, running from the repo root
  // would glob a nonexistent `./src` → 0 files → a misleading "clean" result.
  const root = resolve(import.meta.dir, "..");
  let entries: { display: string; abs: string }[];
  if (args.length > 0) {
    entries = args.map((a) => ({ display: a, abs: resolve(a) }));
  } else {
    const { Glob } = await import("bun");
    const matched = [...new Glob("src/**/*.ts").scanSync(root)];
    if (matched.length === 0) {
      console.error(
        `✖ lint-blocking-in-timers: no source files found under ${root}/src — refusing to report clean.`
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
        `${v.file}:${v.line}:${v.column}  blocking '${v.callee}(...)' inside a setTimeout/setInterval callback`
      );
      total++;
    }
  }

  if (total > 0) {
    console.error(
      `\n✖ ${total} blocking-in-timer violation(s) (Issue #27).\n` +
        `  A *Sync exec inside a timer callback freezes the single-process Supervisor event loop on every tick.\n` +
        `  Use spawn() (async, fire-and-forget) inside timer callbacks instead.`
    );
    process.exit(1);
  }
  console.log("✓ lint-blocking-in-timers: no blocking exec inside timer callbacks");
}
