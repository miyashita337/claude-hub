import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  CLAUDEHUBEXIT_TMUX_SESSION,
  claudeHubExitSessionAlive,
  compactClaudeHubExit,
} from "../../src/session/primary-compact";

/**
 * Issue #405 — test debt for `src/session/primary-compact.ts`, which had no
 * test at all (0% funcs). This module is the ONE sanctioned place where the
 * Supervisor reaches across the tmux socket boundary to the claudeHubExit
 * session, so the properties worth pinning are the boundary ones:
 *   - it targets the `claudeHubExit` session on the DEFAULT socket (empty
 *     socket args), never the Supervisor's `-L claude-hub` socket (RW-019),
 *   - it relays through {@link sendToPane} rather than a second send sequence,
 *   - it refuses an empty intent (RW-032),
 *   - a dead session surfaces as an error instead of silently dropped keys
 *     (#199 AC3).
 *
 * Nothing here touches the real default socket: the liveness probe is pointed
 * at a stub executable, and the relay is injected. Creating or probing a real
 * `claudeHubExit` session would collide with the operator's live one, which
 * CLAUDE.md forbids the Supervisor from managing.
 */

let binDir: string;
/** Stub "tmux" that exits 0 → has-session succeeds → session considered alive. */
let tmuxAlive: string;
/** Stub "tmux" that exits 1 → has-session fails → session considered dead. */
let tmuxDead: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "primary-compact-"));
  tmuxAlive = join(binDir, "tmux-alive");
  tmuxDead = join(binDir, "tmux-dead");
  writeFileSync(tmuxAlive, "#!/bin/sh\nexit 0\n");
  writeFileSync(tmuxDead, "#!/bin/sh\nexit 1\n");
  chmodSync(tmuxAlive, 0o755);
  chmodSync(tmuxDead, 0o755);
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

describe("claudeHubExitSessionAlive", () => {
  test("resolves true when has-session succeeds", async () => {
    expect(await claudeHubExitSessionAlive(tmuxAlive)).toBe(true);
  });

  test("resolves false when has-session fails (no server / no such session)", async () => {
    expect(await claudeHubExitSessionAlive(tmuxDead)).toBe(false);
  });

  test("treats a missing tmux binary as dead instead of rejecting", async () => {
    // Best-effort by design: a spawn error (ENOENT) must not bubble out of the
    // probe, or a mis-set TMUX_PATH would turn a `/session compact` into an
    // unhandled rejection instead of the "session dead" ephemeral.
    const alive = await claudeHubExitSessionAlive(join(binDir, "no-such-tmux"));
    expect(alive).toBe(false);
  });
});

describe("compactClaudeHubExit", () => {
  function recorder() {
    const sends: Array<{
      session: string;
      text: string;
      socketArgs: readonly string[];
    }> = [];
    return {
      sends,
      send: async (
        session: string,
        text: string,
        socketArgs: readonly string[]
      ) => {
        sends.push({ session, text, socketArgs });
      },
    };
  }

  test("relays /compact <intent> to claudeHubExit on the DEFAULT socket", async () => {
    const { sends, send } = recorder();
    await compactClaudeHubExit("relay work", {
      isAlive: async () => true,
      send,
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.session).toBe(CLAUDEHUBEXIT_TMUX_SESSION);
    expect(sends[0]!.text).toBe("/compact relay work");
    // Empty socket args = default socket. A non-empty value here would mean the
    // keystroke went to the Supervisor's own `-L claude-hub` server instead.
    expect(sends[0]!.socketArgs).toEqual([]);
  });

  test("passes the intent through verbatim (spaces and slashes preserved)", async () => {
    const { sends, send } = recorder();
    await compactClaudeHubExit("keep #199 AC1 / socket notes", {
      isAlive: async () => true,
      send,
    });
    expect(sends[0]!.text).toBe("/compact keep #199 AC1 / socket notes");
  });

  test("rejects an empty or whitespace-only intent before probing (RW-032)", async () => {
    for (const intent of ["", "   ", "\n\t"]) {
      const { sends, send } = recorder();
      let probed = false;
      await expect(
        compactClaudeHubExit(intent, {
          isAlive: async () => {
            probed = true;
            return true;
          },
          send,
        })
      ).rejects.toThrow("compact intent must be non-empty (RW-032)");
      // The guard is first: no cross-socket probe, no keystroke.
      expect(probed).toBe(false);
      expect(sends).toHaveLength(0);
    }
  });

  test("throws 'claudeHubExit session dead' and sends nothing when the probe fails (#199 AC3)", async () => {
    const { sends, send } = recorder();
    await expect(
      compactClaudeHubExit("anything", { isAlive: async () => false, send })
    ).rejects.toThrow("claudeHubExit session dead");
    expect(sends).toHaveLength(0);
  });

  test("propagates a relay failure instead of reporting success", async () => {
    // Silent success on a failed send is the exact failure mode #199 AC3 calls
    // out: the user would believe the compact landed when no keys were sent.
    await expect(
      compactClaudeHubExit("boom", {
        isAlive: async () => true,
        send: async () => {
          throw new Error("not in a mode");
        },
      })
    ).rejects.toThrow("not in a mode");
  });
});
