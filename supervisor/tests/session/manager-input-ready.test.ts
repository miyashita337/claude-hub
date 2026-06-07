import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// Isolate DB writes from the real sessions.db (mirrors manager-resume.test.ts).
process.env.SUPERVISOR_DB_PATH = ":memory:";

const { SessionManager } = await import("../../src/session/manager");
const { createFakeEffects } = await import("../../src/session/adapters-fake");
import type { FakeSessionEffects } from "../../src/session/adapters-fake";

/**
 * SessionManager.waitForInputReady (dispatch readiness, RW-025 / RW-047).
 *
 * The dispatch transport injects `/impl <N>` only after the freshly started
 * dept TUI is ready for input; otherwise the Ink slash-picker eats the leading
 * `/` mid-boot and strands the text un-submitted. These tests pin the polling
 * contract: ready marker → true, no marker within the window → false, dead pane
 * → false (so the caller can decide to inject best-effort vs. abort).
 */

const THREAD_ID = "thread-ready-xyz";
// Mirrors SessionManager.tmuxSessionName: `claude-` + threadId.slice(0, 12).
const tmuxName = `claude-${THREAD_ID.slice(0, 12)}`;

// A fresh `--dangerously-skip-permissions` TUI shows this once it accepts input.
const READY_PANE = "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("SessionManager.waitForInputReady (RW-025/047)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;

  beforeEach(() => {
    effects = createFakeEffects();
  });

  afterEach(async () => {
    await manager?.shutdownAll();
  });

  test("returns true once the input-ready marker appears", async () => {
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      inputReadyPollAttempts: 100,
      inputReadyPollIntervalMs: 5,
    });
    effects.tmux.newSession(tmuxName, "claude ...");
    effects.tmux.setPaneContent(tmuxName, READY_PANE);

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(true);
  });

  test("returns false when the marker never appears within the window", async () => {
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      inputReadyPollAttempts: 3,
      inputReadyPollIntervalMs: 5,
    });
    effects.tmux.newSession(tmuxName, "claude ...");
    // Pane shows a still-booting screen with no input-ready marker.
    effects.tmux.setPaneContent(tmuxName, "Loading project context...");

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(false);
  });

  test("returns false immediately when the pane is dead (no tmux session)", async () => {
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      inputReadyPollAttempts: 1000,
      inputReadyPollIntervalMs: 5,
    });
    // No newSession → hasSession(tmuxName) is false → bail out without polling.
    expect(await manager.waitForInputReady(THREAD_ID)).toBe(false);
  });
});
