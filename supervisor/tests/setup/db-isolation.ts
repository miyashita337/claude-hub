// Issue #308: hermetic test isolation for sessions.db.
//
// `src/infra/db.ts` resolves its path ONCE at module load
// (`const DB_PATH = resolveDbPath()`) and caches the Database as a singleton.
// A test file that sets `process.env.SUPERVISOR_DB_PATH = ":memory:"` in its own
// body therefore only wins if it is the FIRST file in the process to pull in
// db.ts. Bun runs many test files in one process, so a single file that touches
// the DB without setting the env binds the singleton to the REAL
// ~/claude-hub/supervisor/sessions.db — and every later `DELETE FROM sessions`
// + fixture insert then truncates production. Measured before this preload
// existed (sandbox HOME, marker row `PRECIOUS-ROW`):
//
//   bun test tests/session/manager.test.ts tests/session/manager-liveness.test.ts
//   → 72 pass / 0 fail, yet PRECIOUS-ROW gone and 2 `/tmp/livenes-test`
//     fixtures left behind — green tests, silent data loss.
//
// Fix: this bun-test preload (wired via bunfig.toml `[test].preload`) runs once
// per `bun test` process, BEFORE any test file loads, so db.ts's module-level
// resolution already sees `:memory:`. Enforced mechanically for every current
// AND future test file — no per-file opt-in to forget. Same isolation spirit as
// runtime-dir-isolation.ts (#341) and SUPERVISOR_TMUX_SOCKET=claude-hub-test
// (RW-019); this is the sessions.db axis of it.
//
// Unlike the runtime-dir preload we do NOT unconditionally override: an
// explicitly provided SUPERVISOR_DB_PATH is a deliberate choice (CI and
// scripts/e2e-orchestrate.sh pass ":memory:"; tests/tools/session-ctl.test.ts
// points at a mkdtemp file to exercise the real sqlite reader). Explicit values
// that are NOT isolated are rejected by the fail-fast guard in db.ts rather than
// silently rewritten here, so a bad value surfaces instead of disappearing.
if (!process.env.SUPERVISOR_DB_PATH) {
  process.env.SUPERVISOR_DB_PATH = ":memory:";
}

// Marker consumed by db.ts's guard (`isUnderTest`) and asserted by
// tests/infra/db-isolation.test.ts. Keeps the guard armed even if a caller
// overrides NODE_ENV, and makes removal of this preload a test failure rather
// than a silent re-exposure of the production DB.
process.env.SUPERVISOR_TEST_ISOLATION = "1";
