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
 * message. waitForInputReady must accept the dialog so the TUI becomes ready,
 * but only for the session's own projectDir (PR #570 review).
 */
const { folderTrustAcceptKeys } = await import("../../src/session/manager");

const PROJECT_DIR = "/Users/x/corp/.claude/worktrees/1119";

// Shape of the real pane (Issue #571 measurement, Claude Code v2.1.327): a
// blank line separates the header from the path.
function trustPane(dir: string = PROJECT_DIR, cursorOnYes = false): string {
  return [
    " Accessing workspace:",
    "",
    ` ${dir}`,
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    cursorOnYes ? "   No, exit" : " ❯ No, exit",
    cursorOnYes ? " ❯ Yes, I trust this folder" : "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
}

describe("folderTrustAcceptKeys (#569)", () => {
  test("cursor on 'No, exit' → Down then Enter", () => {
    expect(folderTrustAcceptKeys(trustPane(), PROJECT_DIR)).toEqual(["Down", "C-m"]);
  });

  test("cursor already on 'Yes' → Enter only", () => {
    expect(folderTrustAcceptKeys(trustPane(PROJECT_DIR, true), PROJECT_DIR)).toEqual(["C-m"]);
  });

  test("a numbered rendering of the options is still accepted", () => {
    const pane = trustPane().replace("❯ No, exit", "❯ 1. No, exit").replace(
      "   Yes, I trust this folder",
      "   2. Yes, I trust this folder"
    );
    expect(folderTrustAcceptKeys(pane, PROJECT_DIR)).toEqual(["Down", "C-m"]);
  });

  test("a path hard-wrapped at the pane width is joined back before comparing (#571)", () => {
    // Verbatim wrap from an 80-column tmux pane (Issue #571).
    const dir =
      "/private/var/folders/g8/bstc0n_s6013tlqsf7vxvcy00000gp/T/trust-verify-wKYw4K/worktrees/" +
      "x".repeat(70);
    const pane = trustPane(dir).replace(
      ` ${dir}`,
      [" /private/var/folders/g8/bstc0n_s6013tlqsf7vxvcy00000gp/T/trust-verify-wKYw4K/w",
       " orktrees/" + "x".repeat(69),
       " x"].join("\n")
    );
    expect(folderTrustAcceptKeys(pane, dir)).toEqual(["Down", "C-m"]);
  });

  test("a dialog for a different folder is not accepted", () => {
    expect(folderTrustAcceptKeys(trustPane("/Users/x/elsewhere"), PROJECT_DIR)).toBeNull();
  });

  test("a dialog for a parent of the projectDir is not accepted", () => {
    expect(folderTrustAcceptKeys(trustPane("/Users/x/corp"), PROJECT_DIR)).toBeNull();
  });

  test("without the confirm footer it is not treated as the dialog", () => {
    const pane = trustPane().replace(" Enter to confirm · Esc to cancel", "");
    expect(folderTrustAcceptKeys(pane, PROJECT_DIR)).toBeNull();
  });

  test("prose that continues past the option text does not match", () => {
    const pane = [
      " Accessing workspace:",
      "",
      ` ${PROJECT_DIR}`,
      "",
      "No, exit the current screen first.",
      "Yes, I trust this folder is the label.",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(folderTrustAcceptKeys(pane, PROJECT_DIR)).toBeNull();
  });
});

describe("SessionManager.waitForInputReady folder-trust dialog (#569)", () => {
  let manager: InstanceType<typeof SessionManager>;
  let effects: FakeSessionEffects;

  function registerSession(projectDir: string): void {
    // waitForInputReady reads the session's projectDir to scope the trust
    // acceptance; register a minimal entry instead of driving start().
    (manager as unknown as { sessions: Map<string, { projectDir: string }> }).sessions.set(
      THREAD_ID,
      { projectDir }
    );
  }

  /** Make the fake pane switch to the ready screen once keys land. */
  function becomeReadyOnKeys(): void {
    const origSendKeys = effects.tmux.sendKeys.bind(effects.tmux);
    effects.tmux.sendKeys = async (name, keys) => {
      await origSendKeys(name, keys);
      effects.tmux.setPaneContent(tmuxName, READY_PANE);
    };
  }

  beforeEach(() => {
    effects = createFakeEffects();
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      inputReadyPollAttempts: 5,
      inputReadyPollIntervalMs: 5,
    });
    effects.tmux.newSession(tmuxName, "claude ...");
  });

  afterEach(async () => {
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.clear();
    await manager?.shutdownAll();
  });

  test("accepts the dialog for the session's own projectDir, then reports ready", async () => {
    registerSession(PROJECT_DIR);
    effects.tmux.setPaneContent(tmuxName, trustPane());
    becomeReadyOnKeys();

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(true);
    expect(effects.tmux.sendKeysCalls).toEqual([{ name: tmuxName, keys: ["Down", "C-m"] }]);
  });

  test("sends no keys when the dialog names a folder other than the session's projectDir", async () => {
    registerSession("/Users/x/other-project");
    effects.tmux.setPaneContent(tmuxName, trustPane());

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(false);
    expect(effects.tmux.sendKeysCalls).toEqual([]);
  });

  test("sends no keys when no session is registered for the thread", async () => {
    effects.tmux.setPaneContent(tmuxName, trustPane());

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(false);
    expect(effects.tmux.sendKeysCalls).toEqual([]);
  });

  test("sends no keys for prose that quotes the options (no ready marker on screen)", async () => {
    registerSession(PROJECT_DIR);
    effects.tmux.setPaneContent(
      tmuxName,
      '⏺ The dialog offers "Yes, I trust this folder" or "No, exit".\n❯ '
    );

    expect(await manager.waitForInputReady(THREAD_ID)).toBe(false);
    expect(effects.tmux.sendKeysCalls).toEqual([]);
  });
});
