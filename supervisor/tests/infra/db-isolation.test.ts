import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { assertTestDbIsolation, resolveDbPath } from "../../src/infra/db";

/**
 * Issue #308: locks the hermetic sessions.db isolation in place.
 *
 * Before this guard existed, `bun test` truncated the LIVE
 * ~/claude-hub/supervisor/sessions.db: db.ts pins its path at module load, so a
 * test file that imported it without setting SUPERVISOR_DB_PATH bound the
 * singleton to production, and a later file's `DELETE FROM sessions` wiped real
 * rows while the suite still reported 0 fail.
 *
 * Two independent defenses are asserted here:
 *   1. the bun-test preload (bunfig.toml → tests/setup/db-isolation.ts) makes
 *      `:memory:` the default before any test file loads, and
 *   2. `assertTestDbIsolation` fails fast if a non-isolated path is resolved
 *      anyway (preload removed, new entry point, explicit bad env value).
 * Removing either one fails a test here instead of silently re-exposing the
 * production DB.
 */
describe("sessions.db test isolation (Issue #308)", () => {
  const productionPath = resolve(
    homedir(),
    "claude-hub",
    "supervisor",
    "sessions.db",
  );

  describe("preload (primary defense)", () => {
    test("SUPERVISOR_DB_PATH is isolated for every test file, with no per-file opt-in", () => {
      // The preload sets this before any test file body runs. This file itself
      // never assigns it — that is the point: isolation must not be opt-in.
      expect(process.env.SUPERVISOR_DB_PATH).toBe(":memory:");
    });

    test("the preload marker is set, so removing the preload breaks this test", () => {
      expect(process.env.SUPERVISOR_TEST_ISOLATION).toBe("1");
    });

    test("resolveDbPath() under test resolves to in-memory, never the production file", () => {
      const path = resolveDbPath();
      expect(path).toBe(":memory:");
      expect(path).not.toBe(productionPath);
    });
  });

  describe("fail-fast guard (defense in depth)", () => {
    test("refuses the production sessions.db path while under test", () => {
      expect(() =>
        assertTestDbIsolation(productionPath, { NODE_ENV: "test" }),
      ).toThrow(/隔離されていない sessions\.db/);
    });

    test("refuses any non-isolated real path, not just the default one", () => {
      expect(() =>
        assertTestDbIsolation("/Users/someone/elsewhere/sessions.db", {
          NODE_ENV: "test",
        }),
      ).toThrow(/Issue #308/);
    });

    test("stays armed via the preload marker even if NODE_ENV is overridden", () => {
      expect(() =>
        assertTestDbIsolation(productionPath, {
          NODE_ENV: "production",
          SUPERVISOR_TEST_ISOLATION: "1",
        }),
      ).toThrow();
    });

    test("allows :memory: and its URI form", () => {
      const env = { NODE_ENV: "test" };
      expect(() => assertTestDbIsolation(":memory:", env)).not.toThrow();
      expect(() =>
        assertTestDbIsolation("file::memory:?cache=shared", env),
      ).not.toThrow();
    });

    test("allows a mkdtemp path, so the real-sqlite reader test keeps working", () => {
      // Mirrors tests/tools/session-ctl.test.ts, which opens a genuine sqlite
      // file under tmpdir() to exercise createRealEffects().
      const dir = mkdtempSync(join(tmpdir(), "db-isolation-test-"));
      try {
        expect(() =>
          assertTestDbIsolation(join(dir, "sessions.db"), { NODE_ENV: "test" }),
        ).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("does not fire outside tests, so the live Supervisor and session-ctl still open the real DB", () => {
      // tools/session-ctl.ts and tools/e2e-live.ts run under plain `bun`, where
      // NODE_ENV is not "test" — they must keep reading production.
      expect(() =>
        assertTestDbIsolation(productionPath, { NODE_ENV: "production" }),
      ).not.toThrow();
      expect(() => assertTestDbIsolation(productionPath, {})).not.toThrow();
    });

    test("resolveDbPath throws when handed an explicit production path under test", () => {
      // An explicit-but-wrong SUPERVISOR_DB_PATH is surfaced, not silently
      // rewritten to :memory: by the preload.
      expect(() =>
        resolveDbPath({
          NODE_ENV: "test",
          SUPERVISOR_DB_PATH: productionPath,
        }),
      ).toThrow(/隔離されていない sessions\.db/);
    });
  });
});
