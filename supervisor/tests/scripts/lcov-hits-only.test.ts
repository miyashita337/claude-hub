import { describe, expect, test } from "bun:test";
import { hitsOnly } from "../../scripts/lcov-hits-only";

/**
 * Issue #300. The filter's whole job is to make the mock-isolated `bun test`
 * runs contribute coverage WITHOUT letting them redefine the denominator: a
 * suite that merely imports a module still emits DA records for it, and Bun
 * instruments a different (larger) line set in those runs. Uploading them raw
 * measured 57.53% -> 42.57% on relay.ts and 77.21% -> 73.61% overall.
 *
 * So the invariants under test are (1) zero-hit records never survive, and
 * (2) merging a filtered report into a base report can only ever flip a line
 * unhit -> hit, never grow the line total. AC-2 of the issue's journey AC.
 */

const DA = (report: string): Map<string, Map<number, number>> => {
  const out = new Map<string, Map<number, number>>();
  let sf = "";
  for (const line of report.split("\n")) {
    if (line.startsWith("SF:")) {
      sf = line.slice(3);
      if (!out.has(sf)) out.set(sf, new Map());
    } else if (line.startsWith("DA:")) {
      const parts = line.slice(3).split(",");
      out.get(sf)!.set(Number(parts[0]), Number(parts[1]));
    }
  }
  return out;
};

describe("hitsOnly", () => {
  test("keeps executed lines and drops zero-hit ones", () => {
    const filtered = hitsOnly(
      ["SF:src/a.ts", "DA:1,3", "DA:2,0", "DA:3,1", "LF:3", "LH:2", "end_of_record"].join("\n"),
    );

    const lines = DA(filtered).get("src/a.ts")!;
    expect([...lines.keys()].sort((x, y) => x - y)).toEqual([1, 3]);
    expect(lines.get(1)).toBe(3);
  });

  test("recomputes LF/LH/FNF/FNH to match what survived", () => {
    const filtered = hitsOnly(
      [
        "SF:src/a.ts",
        "FN:1,covered",
        "FN:9,nope",
        "FNDA:2,covered",
        "FNDA:0,nope",
        "DA:1,2",
        "DA:9,0",
        "FNF:2",
        "FNH:1",
        "LF:2",
        "LH:1",
        "end_of_record",
      ].join("\n"),
    );

    // Every retained line is hit by construction, so found == hit.
    expect(filtered).toContain("LF:1");
    expect(filtered).toContain("LH:1");
    expect(filtered).toContain("FNF:1");
    expect(filtered).toContain("FNH:1");
    expect(filtered).toContain("FNDA:2,covered");
    expect(filtered).not.toContain("nope");
  });

  test("drops a file whose lines were all unhit", () => {
    const filtered = hitsOnly(
      [
        "SF:src/never-run.ts",
        "DA:1,0",
        "DA:2,0",
        "end_of_record",
        "SF:src/run.ts",
        "DA:1,5",
        "end_of_record",
      ].join("\n"),
    );

    expect(filtered).not.toContain("src/never-run.ts");
    expect(filtered).toContain("SF:src/run.ts");
  });

  test("returns empty output when nothing was executed", () => {
    expect(hitsOnly(["SF:src/a.ts", "DA:1,0", "end_of_record"].join("\n"))).toBe("");
  });

  test("merging a filtered report never grows the base line total (#300 AC-2)", () => {
    // Base = the curated run. Isolated = a suite that only *imports* src/a.ts,
    // so it instruments MORE lines (1..4) but executes only line 2.
    const base = ["SF:src/a.ts", "DA:1,1", "DA:2,0", "end_of_record"].join("\n");
    const isolated = [
      "SF:src/a.ts",
      "DA:1,0",
      "DA:2,7",
      "DA:3,0",
      "DA:4,0",
      "end_of_record",
    ].join("\n");

    const baseLines = DA(base).get("src/a.ts")!;
    const addedLines = DA(hitsOnly(isolated)).get("src/a.ts")!;

    // The spurious lines 3 and 4 are gone; only the genuine hit on 2 remains.
    expect([...addedLines.keys()]).toEqual([2]);

    const merged = new Map(baseLines);
    for (const [no, hits] of addedLines) merged.set(no, (merged.get(no) ?? 0) + hits);

    expect(merged.size).toBe(baseLines.size); // denominator untouched
    expect([...merged.values()].filter((h) => h > 0).length).toBe(2); // 1 -> 2 hit
  });

  test("tolerates a report with no trailing end_of_record", () => {
    expect(hitsOnly(["SF:src/a.ts", "DA:1,1"].join("\n"))).toContain("SF:src/a.ts");
  });
});
