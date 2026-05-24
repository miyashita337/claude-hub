import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Shell-exec injection guard (Issue #159, RW-045).
 *
 * `execSync` / `exec` / `Bun.$` run their argument through a shell, so a
 * template literal that interpolates a value (`${...}`) into one of them is a
 * potential command-injection site if the value is ever attacker-influenced.
 * claude-hub has hit this class repeatedly (RW-019 tmux send-keys, PR #147
 * single-quote wrap collapse, PR #157 branch → `cd "<path>"`).
 *
 * This guard scans supervisor/src and fails if such a call lacks a nearby
 * `// shell-safe: <reason>` justification, forcing the author to argue why the
 * interpolated value cannot inject (constant, internal id, escaped, validated
 * at a choke point). `execFileSync` is intentionally NOT flagged — it passes an
 * argv array with no shell, which is the safe alternative.
 */

const SRC_DIR = join(import.meta.dir, "..", "..", "src");
const JUSTIFICATION = "shell-safe:";

/** Shell-executing calls whose first arg is a (possibly multi-line) template literal. */
const SHELL_EXEC_RE = /(?<!execFileSync\s*\()\b(?:execSync|exec)\s*\(\s*`([^`]*)`/gs;
const BUN_SHELL_RE = /\bBun\.\$\s*`([^`]*)`/gs;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

/** Was a `// shell-safe:` comment placed on or within 3 lines above `charIndex`? */
function hasJustificationBefore(content: string, charIndex: number): boolean {
  const before = content.slice(0, charIndex);
  const lines = before.split("\n");
  // Look at the line containing the call plus the 3 preceding lines.
  const window = lines.slice(Math.max(0, lines.length - 4));
  return window.some((l) => l.includes(JUSTIFICATION));
}

function scanFile(file: string): Violation[] {
  const content = readFileSync(file, "utf8");
  const violations: Violation[] = [];

  for (const re of [SHELL_EXEC_RE, BUN_SHELL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const arg = m[1] ?? "";
      if (!arg.includes("${")) continue; // no interpolation → not a concern
      if (hasJustificationBefore(content, m.index)) continue;
      const line = content.slice(0, m.index).split("\n").length;
      violations.push({
        file: file.replace(`${SRC_DIR}/`, "src/"),
        line,
        snippet: arg.slice(0, 60).replace(/\n/g, " "),
      });
    }
  }
  return violations;
}

describe("shell-exec injection guard (#159 / RW-045)", () => {
  test("every interpolated execSync/exec/Bun.$ in src has a // shell-safe justification", () => {
    const violations = listTsFiles(SRC_DIR).flatMap(scanFile);
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line}  \`${v.snippet}...\``)
        .join("\n");
      throw new Error(
        `Unjustified interpolated shell-exec call(s) found. Pass untrusted ` +
          `input via execFileSync (argv) or validate at a choke point, then add ` +
          `a "// shell-safe: <reason>" comment on/above the call:\n${report}`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  // Self-check: the scanner must actually catch an unjustified interpolation
  // (guards against the regex silently matching nothing — RW-021 空振り).
  test("scanner flags an unjustified interpolated execSync (planted)", () => {
    const planted = 'const x = "a";\nexecSync(`echo ${x}`);\n';
    const tmp = join(import.meta.dir, ".planted-violation.tmp.ts");
    require("fs").writeFileSync(tmp, planted);
    try {
      expect(scanFile(tmp).length).toBe(1);
    } finally {
      require("fs").unlinkSync(tmp);
    }
  });

  test("scanner ignores a justified interpolation and execFileSync", () => {
    const ok =
      '// shell-safe: x is a constant\nexecSync(`echo ${x}`);\n' +
      "execFileSync(`${bin}`, [arg]);\n" +
      "execSync(`echo literal`);\n";
    const tmp = join(import.meta.dir, ".justified.tmp.ts");
    require("fs").writeFileSync(tmp, ok);
    try {
      expect(scanFile(tmp).length).toBe(0);
    } finally {
      require("fs").unlinkSync(tmp);
    }
  });
});
