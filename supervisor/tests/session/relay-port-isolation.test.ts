import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import {
  startRelayServer,
  stopRelayServer,
  relayPortFilePath,
} from "../../src/session/relay-server";

// Issue #341: locks the hermetic runtime-dir isolation in place. The bun-test
// preload (bunfig.toml → tests/setup/runtime-dir-isolation.ts) sets
// XDG_RUNTIME_DIR to a throwaway temp dir so start/stopRelayServer() in the
// whole suite writes/unlinks there — never the well-known production path the
// LIVE Supervisor and tools/e2e-live.ts preflight depend on. If the preload is
// ever removed, these assertions fail (cross-platform: the marker check catches
// it even on Linux where XDG is normally /run/user/<uid>).
describe("relay-port isolation (Issue #341)", () => {
  afterEach(() => stopRelayServer());

  test("preload repoints XDG_RUNTIME_DIR at a throwaway temp dir", () => {
    const xdg = process.env.XDG_RUNTIME_DIR;
    expect(xdg).toBeTruthy();
    // Stable marker written by the preload's mkdtemp prefix.
    expect(xdg).toContain("claude-hub-supervisor-test-");
  });

  test("relayPortFilePath resolves under the isolated dir, not the well-known user path", () => {
    const path = relayPortFilePath();
    expect(path).toContain(process.env.XDG_RUNTIME_DIR ?? "\0never");
    expect(path.endsWith("/claude-hub-supervisor/relay-port")).toBe(true);
    // Must not be the production /tmp fallback the live preflight reads.
    const user = process.env.USER || "default";
    expect(path).not.toBe(`/tmp/claude-hub-supervisor-${user}/relay-port`);
  });

  test("start/stop touches only the isolated dir; the well-known production path is left intact", () => {
    const user = process.env.USER || "default";
    // The REAL production path for THIS platform, reconstructed from the XDG
    // value the preload captured before overriding it — so the guard is accurate
    // on Linux CI (XDG = /run/user/<uid>) too, not just the macOS /tmp fallback.
    // Mirrors relayPortFilePath()'s own resolution.
    const originalXdg = process.env.ORIGINAL_XDG_RUNTIME_DIR;
    const wellKnown = originalXdg
      ? `${originalXdg}/claude-hub-supervisor/relay-port`
      : `/tmp/claude-hub-supervisor-${user}/relay-port`;
    // Read-only snapshot of the real path (present or absent) — this test must
    // never itself mutate the production file it is guarding.
    const before = existsSync(wellKnown)
      ? readFileSync(wellKnown, "utf8")
      : null;

    startRelayServer();
    const isolated = relayPortFilePath();
    expect(isolated).not.toBe(wellKnown);
    expect(existsSync(isolated)).toBe(true);
    stopRelayServer();
    expect(existsSync(isolated)).toBe(false);

    const after = existsSync(wellKnown) ? readFileSync(wellKnown, "utf8") : null;
    expect(after).toBe(before);
  });
});
