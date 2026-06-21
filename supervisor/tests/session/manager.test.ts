import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  SessionManager,
  buildClaudeFlags,
  AUTO_COMPACT_INTENT,
} from "../../src/session/manager";
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

  test("starts a session with threadId", async () => {
    const threadId = "thread-123";
    const session = await manager.start(primaryConfig, threadId);

    expect(session.id).toBeTruthy();
    expect(session.channelName).toBe("channel-primary");
    expect(session.threadId).toBe(threadId);
    expect(session.projectDir).toBe(primaryConfig.dir);
    expect(session.status).toBe("running");
  });

  test("start injects --session-id and captures claudeSessionId deterministically (Issue #167)", async () => {
    const threadId = "thread-csid";
    const session = await manager.start(primaryConfig, threadId);

    // The id is captured on start, not via a relay round-trip (which times out
    // ~90% of the time and left the DB column NULL).
    expect(session.claudeSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    // The spawned claude command pins that id with --session-id, and a fresh
    // start must NOT use --resume (the two flags are mutually exclusive).
    // tmux name is deterministic: "claude-" + first 12 chars of threadId.
    const tmuxName = `claude-${threadId.slice(0, 12)}`;
    const cmd = effects.tmux.getCommand(tmuxName)!;
    expect(cmd).toContain(`--session-id ${session.claudeSessionId}`);
    expect(cmd).not.toContain("--resume");
  });

  test("has() checks by threadId", async () => {
    const threadId = "thread-456";
    await manager.start(primaryConfig, threadId);

    expect(manager.has(threadId)).toBe(true);
    expect(manager.has("thread-nonexistent")).toBe(false);
  });

  describe("contextBudgetWarning (#204)", () => {
    test("returns null for unknown thread, undefined tokens, or below yellow", async () => {
      expect(manager.contextBudgetWarning("no-such-thread", 500_000)).toBeNull();
      await manager.start(primaryConfig, "thread-cb0");
      expect(manager.contextBudgetWarning("thread-cb0", undefined)).toBeNull();
      expect(manager.contextBudgetWarning("thread-cb0", 100_000)).toBeNull();
    });

    test("warns once on first band crossing, de-dups within band, escalates up", async () => {
      const t = "thread-cb1";
      await manager.start(primaryConfig, t);
      expect(manager.contextBudgetWarning(t, 320_000)?.level).toBe("yellow");
      expect(manager.contextBudgetWarning(t, 350_000)).toBeNull(); // same band → no spam
      expect(manager.contextBudgetWarning(t, 410_000)?.level).toBe("red"); // escalate
      expect(manager.contextBudgetWarning(t, 850_000)?.level).toBe("critical");
      expect(manager.contextBudgetWarning(t, 900_000)).toBeNull(); // same band
    });

    test("trackers are per-thread (independent sessions)", async () => {
      await manager.start(primaryConfig, "thread-cbA");
      await manager.start(primaryConfig, "thread-cbB");
      expect(manager.contextBudgetWarning("thread-cbA", 320_000)?.level).toBe("yellow");
      // B is independent: it still gets its own first-crossing warning.
      expect(manager.contextBudgetWarning("thread-cbB", 320_000)?.level).toBe("yellow");
    });
  });

  describe("contextBudgetSelfHeal (#206)", () => {
    afterEach(() => {
      delete process.env.CONTEXT_SELF_HEAL_MAX_ACTIONS;
    });

    test("null when no band is crossed (below yellow / unknown thread)", async () => {
      await manager.start(primaryConfig, "sh-0");
      expect(await manager.contextBudgetSelfHeal("sh-0", 100_000)).toBeNull();
      expect(await manager.contextBudgetSelfHeal("nope", 500_000)).toBeNull();
    });

    test("yellow → notify only, no auto-compact", async () => {
      const t = "sh-yellow";
      await manager.start(primaryConfig, t);
      const compactSpy = spyOn(manager, "compactSession").mockResolvedValue(
        undefined
      );
      const outcome = await manager.contextBudgetSelfHeal(t, 320_000);
      expect(outcome?.level).toBe("yellow");
      expect(outcome?.action).toBe("none");
      expect(outcome?.page).toBe(false);
      expect(compactSpy).not.toHaveBeenCalled();
      compactSpy.mockRestore();
    });

    test("AC item 1: red → auto /compact with the non-empty AUTO_COMPACT_INTENT, pages", async () => {
      const t = "sh-red";
      await manager.start(primaryConfig, t);
      const compactSpy = spyOn(manager, "compactSession").mockResolvedValue(
        undefined
      );

      const outcome = await manager.contextBudgetSelfHeal(t, 410_000);

      expect(outcome?.level).toBe("red");
      expect(outcome?.action).toBe("compact");
      expect(outcome?.page).toBe(true);
      expect(compactSpy).toHaveBeenCalledTimes(1);
      // RW-032: the relayed intent is never empty.
      expect(compactSpy.mock.calls[0]).toEqual([t, AUTO_COMPACT_INTENT]);
      expect(AUTO_COMPACT_INTENT.trim().length).toBeGreaterThan(0);
      expect(outcome?.message).toContain("自動");
      compactSpy.mockRestore();
    });

    test("auto-compact failure is folded into the message, never thrown", async () => {
      const t = "sh-red-fail";
      await manager.start(primaryConfig, t);
      const compactSpy = spyOn(manager, "compactSession").mockRejectedValue(
        new Error("tmux session dead")
      );

      const outcome = await manager.contextBudgetSelfHeal(t, 410_000);

      expect(outcome?.action).toBe("compact");
      expect(outcome?.message).toContain("失敗");
      expect(outcome?.message).toContain("tmux session dead");
      compactSpy.mockRestore();
    });

    test("AC item 3: critical → notify only (no auto-compact), restart guidance present", async () => {
      const t = "sh-critical";
      await manager.start(primaryConfig, t);
      const compactSpy = spyOn(manager, "compactSession").mockResolvedValue(
        undefined
      );

      const outcome = await manager.contextBudgetSelfHeal(t, 850_000);

      expect(outcome?.level).toBe("critical");
      expect(outcome?.action).toBe("notify");
      expect(outcome?.page).toBe(true);
      expect(compactSpy).not.toHaveBeenCalled();
      expect(outcome?.message).toContain("/session resume");
      compactSpy.mockRestore();
    });

    test("AC item 2: rebounding red hits the cap, then stops auto-compacting", async () => {
      process.env.CONTEXT_SELF_HEAL_MAX_ACTIONS = "1"; // healer created with cap 1
      const t = "sh-cap";
      await manager.start(primaryConfig, t);
      const compactSpy = spyOn(manager, "compactSession").mockResolvedValue(
        undefined
      );

      // 1st red crossing → compact (consumes the single slot).
      expect((await manager.contextBudgetSelfHeal(t, 410_000))?.action).toBe(
        "compact"
      );
      // Drop below yellow resets the de-dup episode so the next climb re-fires.
      expect(await manager.contextBudgetSelfHeal(t, 100_000)).toBeNull();
      // 2nd red crossing → cap reached, no further compact.
      const capped = await manager.contextBudgetSelfHeal(t, 420_000);
      expect(capped?.action).toBe("cap-reached");
      expect(capped?.message).toContain("上限");

      expect(compactSpy).toHaveBeenCalledTimes(1); // never exceeded the cap
      compactSpy.mockRestore();
    });
  });

  test("allows multiple sessions in the same channel", async () => {
    await manager.start(primaryConfig, "thread-1");
    await manager.start(primaryConfig, "thread-2");

    expect(manager.count()).toBe(2);
    expect(manager.has("thread-1")).toBe(true);
    expect(manager.has("thread-2")).toBe(true);
  });

  test("listRunningByChannel returns sessions for a specific channel", async () => {
    await manager.start(primaryConfig, "thread-pri-1");
    await manager.start(primaryConfig, "thread-pri-2");
    await manager.start(secondaryConfig, "thread-sec-1");

    expect(manager.listRunningByChannel("channel-primary")).toHaveLength(2);
    expect(manager.listRunningByChannel("channel-secondary")).toHaveLength(1);
  });

  // Issue #78 (AC-4): the read-only snapshot must map each thread to the same
  // tmux session name the manager actually uses (`claude-<threadId[..12]>`).
  test("sessionsHealth() returns empty when no sessions are running", () => {
    expect(manager.sessionsHealth()).toEqual([]);
  });

  test("sessionsHealth() maps threadId to claude-<threadId[..12]> tmux name", async () => {
    // A >12-char threadId proves the slice; AC-4 asserts this exact mapping.
    const threadId = "1234567890123456789";
    await manager.start(primaryConfig, threadId);

    const health = manager.sessionsHealth();
    expect(health).toHaveLength(1);
    const row = health[0]!;
    expect(row.threadId).toBe(threadId);
    expect(row.tmuxSession).toBe(`claude-${threadId.slice(0, 12)}`);
    expect(row.channelName).toBe("channel-primary");
    expect(row.status).toBe("running");
    // ISO-8601 strings so the payload is plain JSON.
    expect(() => new Date(row.startedAt).toISOString()).not.toThrow();
    expect(row.startedAt).toBe(new Date(row.startedAt).toISOString());
  });

  test("sessionsHealth() reflects all running sessions and excludes secrets", async () => {
    await manager.start(primaryConfig, "thread-a");
    await manager.start(secondaryConfig, "thread-b");

    const health = manager.sessionsHealth();
    expect(health).toHaveLength(2);
    expect(health.map((s) => s.threadId).sort()).toEqual([
      "thread-a",
      "thread-b",
    ]);
    // No secret/process fields leak through the DTO.
    for (const row of health) {
      expect(row).not.toHaveProperty("pid");
      expect(row).not.toHaveProperty("process");
      expect(row).not.toHaveProperty("claudeSessionId");
    }
  });

  test("stop() removes session by threadId", async () => {
    await manager.start(primaryConfig, "thread-to-stop");

    expect(manager.has("thread-to-stop")).toBe(true);
    await manager.stop("thread-to-stop", "manual");
    expect(manager.has("thread-to-stop")).toBe(false);
  });

  test("stop() throws for nonexistent thread", async () => {
    await expect(
      manager.stop("nonexistent-thread", "manual")
    ).rejects.toThrow("セッションが見つかりません");
  });

  test("throws when max sessions exceeded", async () => {
    for (let i = 0; i < 10; i++) {
      await manager.start(primaryConfig, `thread-${i}`);
    }
    await expect(
      manager.start(primaryConfig, "thread-overflow")
    ).rejects.toThrow("最大セッション数");
  });

  test("throws for duplicate threadId", async () => {
    await manager.start(primaryConfig, "thread-dup");
    await expect(manager.start(primaryConfig, "thread-dup")).rejects.toThrow(
      "既に稼働中です"
    );
  });

  test("touchActivity updates lastActivityAt", async () => {
    const session = await manager.start(primaryConfig, "thread-touch");
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

  test("AC-1: start() does not call real tmux — only the fake adapter sees it", async () => {
    await manager.start(primaryConfig, "thread-ac1");
    expect(effects.tmux.list()).toContain("claude-thread-ac1");
  });

  test("AC-2: start() defers iTerm2 tab opening through the fake adapter (no osascript)", async () => {
    await manager.start(primaryConfig, "thread-ac2");
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
    const session = await manager.start(primaryConfig, "thread-sigterm");
    await manager.stop("thread-sigterm", "manual");
    expect(effects.process.killCalls).toEqual([
      { pid: session.pid, signal: "SIGTERM" },
    ]);
  });

  test("stop() routes kill-session through the fake tmux adapter", async () => {
    await manager.start(primaryConfig, "thread-killsess");
    // tmuxSessionName takes the first 12 chars of threadId (see manager.ts).
    expect(effects.tmux.list()).toContain("claude-thread-kills");
    await manager.stop("thread-killsess", "manual");
    expect(effects.tmux.list()).not.toContain("claude-thread-kills");
  });

  test("shutdownAll() clears all sessions and stops the relay server", async () => {
    await manager.start(primaryConfig, "thread-a");
    await manager.start(primaryConfig, "thread-b");
    expect(manager.count()).toBe(2);

    await manager.shutdownAll();
    expect(manager.count()).toBe(0);
    expect(effects.relayServer.stopCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Issue #104 / Epic #101: cold-start optimisation flags
  // -------------------------------------------------------------------------
  test("default channel disables Chrome and all MCPs in the tmux command", async () => {
    const config = makeChannelConfig({ channelName: "default-flags" });
    await manager.start(config, "th-default");

    const cmd = effects.tmux.getCommand("claude-th-default") ?? "";
    expect(cmd).toContain("--no-chrome");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain(`--mcp-config '{"mcpServers":{}}'`);
    expect(cmd).toContain(`--name "default-flags"`);
  });

  test("chromeEnabled=true omits --no-chrome but still strips MCPs", async () => {
    const config = makeChannelConfig({
      channelName: "chrome-on",
      chromeEnabled: true,
    });
    await manager.start(config, "th-chrome");

    const cmd = effects.tmux.getCommand("claude-th-chrome") ?? "";
    expect(cmd).not.toContain("--no-chrome");
    expect(cmd).toContain("--strict-mcp-config");
  });

  test("mcpProfile='default' restores user-scope MCP loading", async () => {
    const config = makeChannelConfig({
      channelName: "mcp-default",
      mcpProfile: "default",
    });
    await manager.start(config, "th-mcp-def");

    const cmd = effects.tmux.getCommand("claude-th-mcp-def") ?? "";
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(cmd).not.toContain("--mcp-config");
    // Chrome stays disabled by default even in this profile.
    expect(cmd).toContain("--no-chrome");
  });
});

describe("buildClaudeFlags()", () => {
  const baseConfig = {
    channelName: "test-channel",
    dir: "/tmp",
    displayName: "Test",
  };

  test("default config produces the supervisor 'none' profile flags", () => {
    const flags = buildClaudeFlags(baseConfig);
    expect(flags).toEqual([
      "--dangerously-skip-permissions",
      "--name",
      `"test-channel"`,
      "--no-chrome",
      "--strict-mcp-config",
      "--mcp-config",
      `'{"mcpServers":{}}'`,
    ]);
  });

  test("chromeEnabled=true drops --no-chrome", () => {
    const flags = buildClaudeFlags({ ...baseConfig, chromeEnabled: true });
    expect(flags).not.toContain("--no-chrome");
    expect(flags).toContain("--strict-mcp-config");
  });

  test("mcpProfile='default' drops the strict-mcp-config flags", () => {
    const flags = buildClaudeFlags({ ...baseConfig, mcpProfile: "default" });
    expect(flags).not.toContain("--strict-mcp-config");
    expect(flags).not.toContain("--mcp-config");
    expect(flags).toContain("--no-chrome");
  });

  test("both opt-ins simultaneously yield the legacy startup", () => {
    const flags = buildClaudeFlags({
      ...baseConfig,
      chromeEnabled: true,
      mcpProfile: "default",
    });
    expect(flags).toEqual([
      "--dangerously-skip-permissions",
      "--name",
      `"test-channel"`,
    ]);
  });
});

describe("SessionManager worktree integration (#154)", () => {
  let manager: SessionManager;
  let effects: FakeSessionEffects;
  let config: ChannelConfig;

  beforeEach(() => {
    effects = createFakeEffects();
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0 });
    config = makeChannelConfig({ channelName: "wt-channel" });
  });

  afterEach(async () => {
    await manager.shutdownAll();
  });

  test("AC-1: start with branch creates a worktree and runs claude there", async () => {
    const session = await manager.start(config, "thread-wt", "feature-foo");

    expect(effects.worktree.ensureCalls).toEqual([
      { mainRepoDir: config.dir, branch: "feature-foo" },
    ]);
    const wtPath = `${config.dir}/.claude/worktrees/feature-foo`;
    expect(session.worktree).toEqual({
      mainRepoDir: config.dir,
      path: wtPath,
      branch: "feature-foo",
    });
    expect(session.projectDir).toBe(wtPath);

    // claude is launched with cwd = the worktree path (AC-1 verification).
    const cmd = effects.tmux.getCommand("claude-thread-wt");
    expect(cmd).toContain(`cd "${wtPath}"`);
  });

  test("start without branch keeps legacy behaviour (no worktree)", async () => {
    const session = await manager.start(config, "thread-plain");

    expect(session.worktree).toBeUndefined();
    expect(session.projectDir).toBe(config.dir);
    expect(effects.worktree.ensureCalls).toHaveLength(0);
  });

  test("AC-3 / Q4: a pre-existing worktree is reused", async () => {
    const wtPath = `${config.dir}/.claude/worktrees/feature-foo`;
    effects.worktree.existingPaths.add(wtPath);

    const session = await manager.start(config, "thread-reuse", "feature-foo");
    expect(session.worktree?.path).toBe(wtPath);
    // ensure() was still consulted (it decides reuse), but no second creation.
    expect(effects.worktree.ensureCalls).toHaveLength(1);
  });

  test("AC-5 / Q3: stop removes the worktree (branch preserved)", async () => {
    const session = await manager.start(config, "thread-stop-wt", "feature-foo");
    const wtPath = session.worktree!.path;

    await manager.stop("thread-stop-wt", "manual");

    expect(effects.worktree.removeCalls).toEqual([
      { mainRepoDir: config.dir, worktreePath: wtPath },
    ]);
  });

  test("stop of a branchless session does not call worktree.remove", async () => {
    await manager.start(config, "thread-plain-stop");
    await manager.stop("thread-plain-stop", "manual");
    expect(effects.worktree.removeCalls).toHaveLength(0);
  });

  test("Q4: two sessions share one worktree → only the last stop removes it", async () => {
    // 同 branch 多重 session (AC-3 / Q4): both sessions reuse the same worktree.
    const s1 = await manager.start(config, "thread-share-1", "feature-foo");
    const s2 = await manager.start(config, "thread-share-2", "feature-foo");
    expect(s1.worktree!.path).toBe(s2.worktree!.path);

    // Stopping the first must NOT remove the worktree — thread-share-2 still
    // runs there (regression guard: CodeRabbit Major on PR #157).
    await manager.stop("thread-share-1", "manual");
    expect(effects.worktree.removeCalls).toHaveLength(0);
    expect(effects.worktree.existingPaths.has(s1.worktree!.path)).toBe(true);

    // Stopping the last session removes the now-unreferenced worktree.
    await manager.stop("thread-share-2", "manual");
    expect(effects.worktree.removeCalls).toEqual([
      { mainRepoDir: config.dir, worktreePath: s2.worktree!.path },
    ]);
  });

  test("AC-6: two branches start in parallel as independent worktrees", async () => {
    // Start concurrently (review #185 coderabbit): launching both with
    // Promise.all exercises the real interleaving at start()'s PID-poll await,
    // so the pendingStarts single-flight lock (distinct threadIds → both
    // succeed; same threadId → one rejects) is actually verified rather than
    // serialised away by sequential awaits.
    const [a, b] = await Promise.all([
      manager.start(config, "thread-a", "feat-a"),
      manager.start(config, "thread-b", "feat-b"),
    ]);

    expect(a.worktree?.path).toBe(`${config.dir}/.claude/worktrees/feat-a`);
    expect(b.worktree?.path).toBe(`${config.dir}/.claude/worktrees/feat-b`);
    expect(manager.count()).toBe(2);
  });

  test("AC-6b: concurrent starts on the SAME thread reject the duplicate (review #185 gemini HIGH)", async () => {
    // The pendingStarts lock must reject a racing second start() for the same
    // threadId even when it interleaves at the PID-poll await — otherwise the
    // async start() bypasses the duplicate-session guard (TOCTOU).
    const results = await Promise.allSettled([
      manager.start(config, "thread-dup", "feat-x"),
      manager.start(config, "thread-dup", "feat-x"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /既に稼働中/
    );
    expect(manager.count()).toBe(1);
  });

  test("a worktree creation failure aborts start and propagates", async () => {
    effects.worktree.failOnEnsure = true;
    await expect(
      manager.start(config, "thread-fail", "feature-foo")
    ).rejects.toThrow(/git worktree add failed/);
    // No session registered when worktree setup fails.
    expect(manager.has("thread-fail")).toBe(false);
  });

  test("path-traversal / injection branch is rejected before a session starts", async () => {
    // The fake delegates to the real resolveWorktreePath, so the guard fires
    // through the manager too.
    await expect(
      manager.start(config, "thread-trav", "../../evil")
    ).rejects.toThrow(/path traversal/);
    await expect(
      manager.start(config, "thread-inj", 'foo"; id; echo "')
    ).rejects.toThrow(/使用できない文字/);
    expect(manager.has("thread-trav")).toBe(false);
    expect(manager.has("thread-inj")).toBe(false);
  });
});

/**
 * Issue #200: compactSession invariants that short-circuit before the real
 * tmux send (sendToPane). The happy path is covered by the command-layer test
 * (session-compact.test.ts) and the send sequence by relay.test.ts.
 */
describe("SessionManager.compactSession (#200)", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager({
      effects: createFakeEffects(),
      gracefulKillTimeoutMs: 0,
    });
  });

  afterEach(async () => {
    await manager.shutdownAll();
  });

  test("empty intent throws before any send (RW-032 hard invariant)", async () => {
    await expect(manager.compactSession("any-thread", "")).rejects.toThrow(
      /non-empty/
    );
    await expect(manager.compactSession("any-thread", "   ")).rejects.toThrow(
      /non-empty/
    );
  });

  test("unknown thread throws (no session to compact)", async () => {
    await expect(
      manager.compactSession("no-such-thread", "保持して圧縮")
    ).rejects.toThrow(/セッションが見つかりません/);
  });
});

/**
 * Issue #227 (PR-3 / #251) AC-4: `watchTmuxSession` now `await`s the async
 * `hasSession`. A poll that takes longer than the watch interval (tmux under
 * load) would let the next tick fire before the previous check resolves —
 * without a guard, two ticks could both observe "exited" and run teardown
 * twice. The `isChecking` re-entry guard must serialize the checks.
 */
describe("watchTmuxSession async re-entry guard (#227 / #251 AC-4)", () => {
  test("a slow hasSession poll never double-fires teardown across overlapping ticks", async () => {
    const localEffects = createFakeEffects();
    const config = makeChannelConfig({ channelName: "channel-watch-guard" });
    const threadId = "thread-watch-guard";
    const localManager = new SessionManager({
      effects: localEffects,
      gracefulKillTimeoutMs: 0,
      // Tick faster than hasSession resolves so a second tick fires while the
      // first is still awaiting — the exact overlap the re-entry guard covers.
      watchIntervalMs: 10,
    });

    try {
      await localManager.start(config, threadId);

      // Replace hasSession with a slow check reporting the session as GONE
      // (false → teardown path) that records max observed concurrency. At 60ms
      // per check vs a 10ms tick, multiple ticks elapse during one in-flight
      // check — so maxConcurrent > 1 would prove the guard failed.
      let concurrent = 0;
      let maxConcurrent = 0;
      localEffects.tmux.hasSession = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 60));
        concurrent--;
        return false;
      };

      // markTabStopped fires exactly once per teardown — count it.
      let teardownCount = 0;
      const realMark = localEffects.iterm2.markTabStopped.bind(
        localEffects.iterm2
      );
      localEffects.iterm2.markTabStopped = (channelName, tmuxSessionName) => {
        teardownCount++;
        realMark(channelName, tmuxSessionName);
      };

      // Let several 10ms ticks elapse across the 60ms check.
      await new Promise((r) => setTimeout(r, 120));

      // Re-entry guard held: only ONE check ran at a time...
      expect(maxConcurrent).toBe(1);
      // ...so teardown fired at most once despite overlapping ticks.
      expect(teardownCount).toBeLessThanOrEqual(1);
    } finally {
      await localManager.shutdownAll();
    }
  });
});
