#!/usr/bin/env bun
/**
 * Strip every zero-hit record from an lcov report, keeping only positive hits.
 *
 * Why this exists (#300)
 * ---------------------
 * The Unit Tests job runs one big curated `bun test` plus four mock-isolated
 * ones. The isolated suites call `mock.module("child_process")`, which is
 * process-global in Bun, so they cannot share a process with the curated list.
 * They used to run without `--coverage` entirely, which silently discarded
 * their coverage: PR #378 changed `adapters.ts` and added
 * `adapters-hassession.test.ts` in the same PR, yet Codecov scored it 27.58% of
 * diff hit. That false FAIL only stayed invisible because patch was
 * informational.
 *
 * Uploading the isolated reports raw does not work either. A suite that merely
 * *imports* a module still emits DA records for it, and Bun instruments a
 * different (larger) line set in those runs. Measured on this repo:
 * relay-nonblocking contributes 0 newly-hit lines to `relay.ts` but 77
 * instrumented-and-unhit ones, dragging it 57.53% -> 42.57% and the whole
 * report 77.21% -> 73.61%. Merging raw reports makes coverage look *worse*.
 *
 * So the rule is: the curated run is the sole source of the denominator, and
 * the isolated runs may only ever *add* evidence that a line was executed.
 * Dropping zero-hit records enforces exactly that — a line Codecov already
 * knows about can flip unhit -> hit, and nothing new enters the denominator.
 * Nothing is hidden relative to today's baseline: any line the curated run
 * instruments stays in its report untouched.
 *
 * Measured effect of the filtered merge: adapters.ts 38.18% -> 61.82%,
 * tmux.ts 70.59% -> 91.18%, relay.ts unchanged, total 77.21% -> 78.15%, with
 * an identical line denominator (7679).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Keep only `DA:`/`FNDA:` records with a non-zero hit count, and drop files
 * left with no executed line at all. `LF`/`LH`/`FNF`/`FNH` are recomputed so
 * the emitted report stays internally consistent (every retained line is hit,
 * so found == hit by construction).
 */
export function hitsOnly(source: string): string {
  const out: string[] = [];
  let body: string[] = [];
  let sourceFile = "";
  let lines = 0;
  let functions = 0;

  const flush = (): void => {
    if (sourceFile && lines > 0) {
      out.push(
        `SF:${sourceFile}`,
        ...body,
        `FNF:${functions}`,
        `FNH:${functions}`,
        `LF:${lines}`,
        `LH:${lines}`,
        "end_of_record",
      );
    }
    body = [];
    sourceFile = "";
    lines = 0;
    functions = 0;
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      flush();
      sourceFile = line.slice(3);
    } else if (line.startsWith("DA:")) {
      const [lineNo, hits] = line.slice(3).split(",");
      if (Number(hits) > 0) {
        body.push(`DA:${lineNo},${hits}`);
        lines++;
      }
    } else if (line.startsWith("FNDA:")) {
      const comma = line.indexOf(",");
      if (Number(line.slice(5, comma)) > 0) {
        body.push(line);
        functions++;
      }
    } else if (line === "end_of_record") {
      flush();
    }
    // FN:/BRDA:/LF:/LH:/FNF:/FNH: are intentionally dropped — they either name
    // records we did not keep or are counts we recompute above. (Bun emits no
    // BRDA at all: its lcov reporter has no branch data, see #300 / #296.)
  }
  flush();

  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: bun scripts/lcov-hits-only.ts <input.info> <output.info>");
    process.exit(2);
  }
  // Fail loudly rather than emitting an empty report: a silently-missing
  // upload would drop coverage on every PR once patch is blocking (RW-029).
  if (!existsSync(input)) {
    console.error(`lcov-hits-only: input not found: ${input}`);
    process.exit(1);
  }
  const filtered = hitsOnly(readFileSync(input, "utf8"));
  if (filtered === "") {
    console.error(`lcov-hits-only: ${input} contains no executed line`);
    process.exit(1);
  }
  writeFileSync(output, filtered);
  console.log(`lcov-hits-only: ${input} -> ${output}`);
}
