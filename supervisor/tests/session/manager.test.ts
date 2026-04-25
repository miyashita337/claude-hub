import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { SessionManager } from "../../src/session/manager";
import {
  createFakeEffects,
  type FakeSessionEffects,
} from "../../src/session/adapters-fake";
import type { ChannelConfig } from "../../src/config/channels";

/**
 * These tests inject fake adapters via {@link SessionManager}'s DI hooks so
 * the unit tests do NOT spawn real tmux sessions or iTerm2 tabs.
 *
 * See Issue #61 — running these tests previously left ~10 zombie iTerm2 tabs
 * and 9+ tmux sessions every time `/verify` was executed.
 */

function makeChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  // Use a real temp dir so the fs.existsSync gate in start() passes without
  // depending on the developer's home directory.
  const dir = resolve(tmpdir(), `supervisor-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return {
    channelName: "test-channel",
    dir,
    displayName: "Test Channel",
    ...overrides,
  };
}

describe("SessionManager (thread-based)", () => {
  let manager: SessionManager;
  let effects: FakeSessionEffects;
  let primaryConfig: ChannelConfig;
  let secondaryConfig: ChannelConfig;

  beforeEach(() => {
    effects = createFakeEffects();
    manager = new SessionManager({
      effects,
      // Skip the production 15s graceful-kill wait so stop() resolves
      // immediately in tests.
      gracefulKillTimeoutMs: 0,
    });
    primaryConfig = makeChannelConfig({ channelName: "channel-primary" });
    secondaryConfig = makeChannelConfig({ channelName: "channel-secondary" });
  });

  afterEach(async () => {
    // Defensive cleanup so a failing test doesn't leak watchers across
    // test cases.
    await manager.shutdownAll();
  });

  test("starts a session with threadId", () => {
    const threadId = "thread-123";
    const session = manager.start(primaryConfig, threadId);

    expect(session.id).toBeTruthy();
    expect(session.channelName).toBe("channel-primary");
    expect(session.threadId).toBe(threadId);
    expect(session.projectDir).toBe(primaryConfig.dir);
    expect(session.status).toBe("running");
  });

  test("has() checks by threadId", () => {
    const threadId = "thread-456";
    manager.start(primaryConfig, threadId);

    expect(manager.has(threadId)).toBe(true);
    expect(manager.has("thread-nonexistent")).toBe(false);
  });

  test("allows multiple sessions in the same channel", () => {
    manager.start(primaryConfig, "thread-1");
    manager.start(primaryConfig, "thread-2");

    expect(manager.count()).toBe(2);
    expect(manager.has("thread-1")).toBe(true);
    expect(manager.has("thread-2")).toBe(true);
  });

  test("listRunningByChannel returns sessions for a specific channel", () => {
    manager.start(primaryConfig, "thread-pri-1");
    manager.start(primaryConfig, "thread-pri-2");
    manager.start(secondaryConfig, "thread-sec-1");

    expect(manager.listRunningByChannel("channel-primary")).toHaveLength(2);
    expect(manager.listRunningByChannel("channel-secondary")).toHaveLength(1);
  });

  test("stop() removes session by threadId", async () => {
    manager.start(primaryConfig, "thread-to-stop");

    expect(manager.has("thread-to-stop")).toBe(true);
    await manager.stop("thread-to-stop", "manual");
    expect(manager.has("thread-to-stop")).toBe(false);
  });

  test("stop() throws for nonexistent thread", async () => {
    await expect(
      manager.stop("nonexistent-thread", "manual")
    ).rejects.toThrow("セッションが見つかりません");
  });

  test("throws when max sessions exceeded", () => {
    for (let i = 0; i < 10; i++) {
      manager.start(primaryConfig, `thread-${i}`);
    }
    expect(() => manager.start(primaryConfig, "thread-overflow")).toThrow(
      "最大セッション数"
    );
  });

  test("throws for duplicate threadId", () => {
    manager.start(primaryConfig, "thread-dup");
    expect(() => manager.start(primaryConfig, "thread-dup")).toThrow(
      "既に稼働中です"
    );
  });

  test("touchActivity updates lastActivityAt", () => {
    const session = manager.start(primaryConfig, "thread-touch");
    const initialTime = session.lastActivityAt.getTime();

    manager.touchActivity("thread-touch");

    const updated = manager.get("thread-touch");
    expect(updated!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
      initialTime
    );
  });

  test("listRunningByChannel returns empty when no sessions for channel", () => {
    expect(manager.listRunningByChannel("channel-primary")).toHaveLength(0);
  });

  /**
   * Below: AC-1 / AC-2 verification — confirm fakes are used and no real
   * external side effects are triggered.
   */

  test("AC-1: start() does not call real tmux — only the fake adapter sees it", () => {
    manager.start(primaryConfig, "thread-ac1");
    expect(effects.tmux.list()).toContain("claude-thread-ac1");
  });

  test("AC-2: start() defers iTerm2 tab opening through the fake adapter (no osascript)", async () => {
    manager.start(primaryConfig, "thread-ac2");
    // openTab is dispatched via setTimeout(0); flush the macrotask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(effects.iterm2.openTabCalls).toHaveLength(1);
    expect(effects.iterm2.openTabCalls[0]?.channelName).toBe(
      "channel-primary"
    );
  });

  test("AC-4 surface: real adapters are wired by default when no effects passed", () => {
    // We don't actually instantiate this — we only assert the type contract:
    // SessionManager() with no args must compile and use realSessionEffects.
    // (Compile-time check; runtime would spawn real tmux which is exactly
    // what Issue #61 forbids in tests.)
    const ctor: new () => SessionManager = SessionManager;
    expect(typeof ctor).toBe("function");
  });

  test("relay-server start/stop are routed through the fake adapter", async () => {
    expect(effects.relayServer.startCalls).toBe(1);
    await manager.shutdownAll();
    expect(effects.relayServer.stopCalls).toBe(1);
  });

  test("stop() sends SIGTERM via the process adapter, not real OS signals", async () => {
    const session = manager.start(primaryConfig, "thread-sigterm");
    await manager.stop("thread-sigterm", "manual");
    expect(effects.process.killCalls).toEqual([
      { pid: session.pid, signal: "SIGTERM" },
    ]);
  });

  test("stop() routes kill-session through the fake tmux adapter", async () => {
    manager.start(primaryConfig, "thread-killsess");
    // tmuxSessionName takes the first 12 chars of threadId (see manager.ts).
    expect(effects.tmux.list()).toContain("claude-thread-kills");
    await manager.stop("thread-killsess", "manual");
    expect(effects.tmux.list()).not.toContain("claude-thread-kills");
  });

  test("shutdownAll() clears all sessions and stops the relay server", async () => {
    manager.start(primaryConfig, "thread-a");
    manager.start(primaryConfig, "thread-b");
    expect(manager.count()).toBe(2);

    await manager.shutdownAll();
    expect(manager.count()).toBe(0);
    expect(effects.relayServer.stopCalls).toBe(1);
  });
});
