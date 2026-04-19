// P0×12 routing rule tests for claudeHubExit (S5 #51 / Epic #45).
//
// The actual assertions live in the shell harness — this bun test shells out
// so the same matrix is reachable via both:
//   bash scripts/test-hijoguchi-routing.sh --priority p0
//   bun test tests/hijoguchi-routing/p0.test.ts
//
// Keeping the logic in shell (not TypeScript) avoids double-maintenance and
// matches the existing scripts/test-*.sh convention used by #49 AC-4.
import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/test-hijoguchi-routing.sh");

// Each subtest spawns ~12-25 fresh bash processes to run start-hijoguchi.sh in
// render-only mode. 5s default is too tight; 60s is plenty of headroom while
// still catching a runaway hang.
const TIMEOUT_MS = 60_000;

describe("hijoguchi routing — P0 (critical path × 12)", () => {
  test("shell harness exits 0 for --priority p0 (12/12 PASS)", async () => {
    const result = await $`bash ${SCRIPT_PATH} --priority p0`.quiet().nothrow();
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    if (result.exitCode !== 0) {
      console.error("--- routing-test stdout ---\n" + stdout);
      console.error("--- routing-test stderr ---\n" + stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("PASS: 12/12");
    expect(stdout).toContain("ALL TESTS PASSED");
  }, TIMEOUT_MS);
});

describe("hijoguchi routing — full matrix × 25", () => {
  test("shell harness exits 0 for default (25/25 PASS)", async () => {
    const result = await $`bash ${SCRIPT_PATH}`.quiet().nothrow();
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    if (result.exitCode !== 0) {
      console.error("--- routing-test stdout ---\n" + stdout);
      console.error("--- routing-test stderr ---\n" + stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("PASS: 25/25");
  }, TIMEOUT_MS);
});
