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

/**
 * Issue #569: an untrusted projectDir (e.g. a corp worktree) shows Claude
 * Code's folder-trust dialog instead of the input-ready marker, and the relay's
 * leading Escape answers it with "cancel" — Claude Code quits on the first
 * message. waitForInputReady must accept the dialog so the TUI becomes ready.
 */
describe("SessionManager.waitForInputReady folder-trust dialog (#569)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;

  // Verbatim shape of the pane captured in Issue #569 (Claude Code v2.1.327).
  const TRUST_PANE = [
    " Accessing workspace:",
    " /Users/x/corp/.claude/worktrees/1119",
    " Quick safety check: Is this a project you created or one you trust?",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  beforeEach(() => {
    effects = createFakeEffects();
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      inputReadyPollAttempts: 50,
      inputReadyPollIntervalMs: 5,
    });
    effects.tmux.newSession(tmuxName, "claude ...");
  });

  afterEach(async () => {
    await manager?.shutdownAll();
  });

  test("moves the cursor from 'No, exit' to 'Yes' and confirms, then reports ready", async () => {
    effects.tmux.setPaneContent(tmuxName, TRUST_PANE);
    // The fake pane switches to the ready screen once the keys land.
    const origSendKeys = effects.tmux.sendKeys.bind(effects.tmux);
    effects.tmux.sendKeys = async (name, keys) => {
      await origSendKeys(name, keys);
      effects.tmux.setPaneContent(tmuxName, READY_PANE);
    };

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(true);
    expect(effects.tmux.sendKeysCalls).toEqual([{ name: tmuxName, keys: ["Down", "C-m"] }]);
  });

  test("only confirms when the cursor already rests on 'Yes'", async () => {
    effects.tmux.setPaneContent(
      tmuxName,
      TRUST_PANE.replace(" ❯ No, exit", "   No, exit").replace(
        "   Yes, I trust this folder",
        " ❯ Yes, I trust this folder"
      )
    );
    const origSendKeys = effects.tmux.sendKeys.bind(effects.tmux);
    effects.tmux.sendKeys = async (name, keys) => {
      await origSendKeys(name, keys);
      effects.tmux.setPaneContent(tmuxName, READY_PANE);
    };

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(true);
    expect(effects.tmux.sendKeysCalls).toEqual([{ name: tmuxName, keys: ["C-m"] }]);
  });

  test("sends no keys for prose that merely mentions one of the options", async () => {
    effects.tmux.setPaneContent(
      tmuxName,
      "⏺ The dialog offers \"Yes, I trust this folder\" or No, exit.\n❯ \n  ⏵⏵ bypass permissions on"
    );

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(true);
    expect(effects.tmux.sendKeysCalls).toEqual([]);
  });

  test("never sends keys when the dialog is absent and the marker never appears", async () => {
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      inputReadyPollAttempts: 3,
      inputReadyPollIntervalMs: 5,
    });
    effects.tmux.setPaneContent(tmuxName, "Loading project context...");

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(false);
    expect(effects.tmux.sendKeysCalls).toEqual([]);
  });
});
