// Issue #341: hermetic test isolation for the per-user runtime dir.
//
// `relayPortFilePath()` (relay-server.ts) and `relayUrlFilePath()` (manager.ts)
// both resolve a single well-known path per user:
//   $XDG_RUNTIME_DIR/claude-hub-supervisor/…   (when XDG is set), else
//   /tmp/claude-hub-supervisor-<USER>/…
// A LIVE Supervisor writes its relay-port there and `tools/e2e-live.ts`'s
// preflight reads it. Because the path is process-shared, any hermetic test
// that calls start/stopRelayServer() would writeFile (start) then unlink (stop)
// the LIVE Supervisor's port file — destroying port discovery for
// session-ctl / /orchestrate and making the live E2E preflight structurally
// FAIL (self-inflicted). See the issue's decisive reproduction.
//
// Fix (案A): this bun-test preload (wired via bunfig.toml `[test].preload`)
// runs once per `bun test` process, BEFORE any test file loads, and points
// XDG_RUNTIME_DIR at a throwaway temp dir. Every runtime-file resolution in the
// suite then lands under that temp dir, so tests can never touch the well-known
// production path. Same isolation spirit as SUPERVISOR_TMUX_SOCKET=claude-hub-test
// (RW-019), but applied to the runtime dir and enforced mechanically for every
// current AND future test file (no per-file opt-in to forget).
//
// We ALWAYS override (not "only when unset"): on Linux dev/CI machines XDG is
// normally set to /run/user/<uid>, and we must not touch that either.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Prefix carries a stable marker (`claude-hub-supervisor-test`) that the
// regression guard (tests/session/relay-port-isolation.test.ts) asserts on, so
// removing this preload is caught by a failing test rather than silently
// re-exposing the production path.
const isolatedRuntimeDir = mkdtempSync(
  join(tmpdir(), "claude-hub-supervisor-test-"),
);
// Preserve the pre-override value so the regression guard
// (tests/session/relay-port-isolation.test.ts) can reconstruct the REAL
// production relay-port path for THIS platform and assert it stays untouched:
// Linux CI → $XDG_RUNTIME_DIR/claude-hub-supervisor/… (XDG is normally
// /run/user/<uid>), macOS → the /tmp/claude-hub-supervisor-<USER>/… fallback.
// Empty string encodes "was unset" (→ /tmp fallback), matching
// relayPortFilePath()'s own resolution.
process.env.ORIGINAL_XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR ?? "";
process.env.XDG_RUNTIME_DIR = isolatedRuntimeDir;

// Best-effort cleanup so repeated runs don't litter the temp root. Fail-soft:
// an unremovable temp dir must never fail the test run. Idempotent (rmSync with
// force), so running it from both a signal handler and the subsequent `exit`
// event is harmless.
const cleanup = () => {
  try {
    rmSync(isolatedRuntimeDir, { recursive: true, force: true });
  } catch {
    // ignore — OS will reclaim the temp dir eventually
  }
};

// Normal termination.
process.on("exit", cleanup);
// SIGINT (Ctrl+C) / SIGTERM do NOT fire the `exit` event, so an interrupted
// `bun test` would otherwise leak the temp dir. Clean up, then re-exit with the
// conventional 128+signal code to preserve interrupt semantics.
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
