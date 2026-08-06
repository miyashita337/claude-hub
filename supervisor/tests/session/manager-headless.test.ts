import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  SessionManager,
  buildHeadlessClaudeFlags,
  buildPendingGuardFlags,
  resolveDispatchModel,
} from "../../src/session/manager";
import {
  createFakeEffects,
  FakeExecutorAdapter,
  type FakeSessionEffects,
} from "../../src/session/adapters-fake";
import type {
  ExecutorAdapter,
  HeadlessRunOptions,
  HeadlessRunResult,
} from "../../src/session/adapters";
import { resolveWorktreePath } from "../../src/session/worktree";
import { getSessionByClaudeSessionId } from "../../src/infra/db";
import type { ChannelConfig } from "../../src/config/channels";

/**
 * Epic #285 Phase 2 / #286 + #288: SessionManager.runHeadless. Uses the DI fakes
 * so no real `claude` is spawned. Asserts:
 *   - the headless argv/cwd handed to the executor (AC-1),
 *   - the session is registered while the child runs and freed on exit (AC-3),
 *   - the DB terminal reason distinguishes a timeout,
 *   - the start guards (dup) and spawn-failure surfacing hold.
 */

/**
 * Neutral artifact probe (Issue #342 Layer 2 extension) for tests that do NOT
 * exercise the artifact path: `found` adds no warning and changes no
 * retention, and injecting it keeps unit tests from shelling out to the real
 * git/gh-backed default.
 */
const foundArtifactsFn = async () => ({
  status: "found" as const,
  detail: "commit deadbeef",
  dirty: false,
});

function makeChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  const dir = resolve(tmpdir(), `headless-mgr-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return {
    channelName: "test-channel",
    dir,
    displayName: "Test Channel",
    ...overrides,
  };
}

describe("SessionManager.runHeadless", () => {
  let manager: SessionManager;
  let effects: FakeSessionEffects;
  let config: ChannelConfig;

  beforeEach(() => {
    effects = createFakeEffects();
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      probeArtifactsFn: foundArtifactsFn,
    });
    config = makeChannelConfig({ channelName: "chan-hl" });
  });

  afterEach(async () => {
    await manager.shutdownAll();
  });

  test("spawns claude -p with the headless flags in the worktree cwd (AC-1)", async () => {
    const res = await manager.runHeadless(
      config,
      "thread-hl-1",
      "/impl 42",
      "corp-dispatch-42",
    );

    expect(effects.executor.runHeadlessCalls).toHaveLength(1);
    const call = effects.executor.runHeadlessCalls[0]!;
    // -p <command> first, session id pinned, TUI-only --name excluded.
    expect(call.args.slice(0, 2)).toEqual(["-p", "/impl 42"]);
    expect(call.args).toContain("--dangerously-skip-permissions");
    expect(call.args).toContain("--strict-mcp-config");
    expect(call.args).toContain('{"mcpServers":{}}');
    // JSON output so usage.output_tokens is machine-readable for the report (#289).
    expect(call.args).toContain("--output-format");
    expect(call.args).toContain("json");
    expect(call.args).not.toContain("--name");
    // --session-id is pinned to the returned claudeSessionId.
    const idIdx = call.args.indexOf("--session-id");
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[idIdx + 1]).toBe(res.claudeSessionId);
    // cwd is the per-branch worktree, not the channel dir.
    expect(call.cwd).toBe(resolveWorktreePath(config.dir, "corp-dispatch-42"));
    // env carries no ANTHROPIC_API_KEY (Claude Max) and a PATH.
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.PATH).toBeTruthy();
  });

  test("registers the session while the child runs and frees the slot on exit (AC-3)", async () => {
    // A deferred executor lets us observe the in-flight registration.
    class DeferredExecutor implements ExecutorAdapter {
      calls: HeadlessRunOptions[] = [];
      private resolveResult!: (r: HeadlessRunResult) => void;
      private markSpawned!: () => void;
      whenSpawned = new Promise<void>((res) => {
        this.markSpawned = res;
      });
      async runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
        this.calls.push(opts);
        opts.onSpawn?.(4242);
        this.markSpawned();
        return new Promise<HeadlessRunResult>((res) => {
          this.resolveResult = res;
        });
      }
      finish(r: HeadlessRunResult): void {
        this.resolveResult(r);
      }
    }
    const exec = new DeferredExecutor();
    const mgr = new SessionManager({
      effects: { ...createFakeEffects(), executor: exec },
      gracefulKillTimeoutMs: 0,
      probeArtifactsFn: foundArtifactsFn,
    });

    const p = mgr.runHeadless(config, "thread-run", "/impl 1", "corp-dispatch-1");
    await exec.whenSpawned;
    // Registered during the run: slot is occupied, marked headless.
    expect(mgr.count()).toBe(1);
    expect(mgr.has("thread-run")).toBe(true);
    expect(mgr.get("thread-run")?.executor).toBe("headless");

    exec.finish({
      exitCode: 0,
      stdout: "PR ready",
      stderr: "",
      timedOut: false,
      durationMs: 12,
    });
    const res = await p;

    // Freed on exit; DB row closed with the non-timeout reason.
    expect(mgr.count()).toBe(0);
    expect(mgr.has("thread-run")).toBe(false);
    const row = getSessionByClaudeSessionId(res.claudeSessionId);
    expect(row?.status).toBe("stopped");
    expect(row?.stopped_reason).toBe("headless_exited");
    await mgr.shutdownAll();
  });

  test("records headless_timeout when the run times out", async () => {
    effects.executor.result = {
      exitCode: null,
      stdout: "partial",
      stderr: "",
      timedOut: true,
      durationMs: 999,
    };
    const res = await manager.runHeadless(config, "thread-to", "/pdca 9", "corp-dispatch-9");
    expect(res.timedOut).toBe(true);
    const row = getSessionByClaudeSessionId(res.claudeSessionId);
    expect(row?.stopped_reason).toBe("headless_timeout");
    expect(manager.has("thread-to")).toBe(false);
  });

  test("parses usage.output_tokens + result text from the JSON envelope (#289)", async () => {
    // A realistic `claude -p --output-format json` envelope.
    effects.executor.result = {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        result: "PR opened: https://github.com/x/y/pull/9",
        duration_ms: 4200,
        usage: { input_tokens: 1200, output_tokens: 345 },
      }),
      stderr: "",
      timedOut: false,
      durationMs: 4500,
    };
    const res = await manager.runHeadless(
      config,
      "thread-json",
      "/impl 9",
      "corp-dispatch-9",
      9,
    );
    // Presentable text is the parsed `result`, not the raw JSON.
    expect(res.stdout).toBe("PR opened: https://github.com/x/y/pull/9");
    expect(res.tokens).toBe(345);
    expect(res.durationMs).toBe(4500);
  });

  test("posts the dispatch report to the target Issue from the worktree cwd (#289)", async () => {
    effects.executor.result = {
      exitCode: 0,
      stdout: JSON.stringify({
        result: "done",
        usage: { output_tokens: 500 },
      }),
      stderr: "",
      timedOut: false,
      durationMs: 3000,
    };
    await manager.runHeadless(config, "thread-rep", "/impl 42", "corp-dispatch-42", 42);

    expect(effects.issueReporter.postCommentCalls).toHaveLength(1);
    const call = effects.issueReporter.postCommentCalls[0]!;
    expect(call.issueNumber).toBe(42);
    expect(call.cwd).toBe(resolveWorktreePath(config.dir, "corp-dispatch-42"));
    expect(call.body).toContain("## Dispatch 実行レポート");
    expect(call.body).toContain("- tokens: 500");
    expect(call.body).toContain("- duration_ms: 3000");
    expect(call.body).toContain("- exit_code: 0");
  });

  test("omits the tokens line when usage is unavailable (no fabrication, #289)", async () => {
    effects.executor.result = {
      exitCode: 2,
      // Non-JSON output (e.g. a crash before the envelope) → tokens unknown.
      stdout: "boom, not json",
      stderr: "fatal",
      timedOut: false,
      durationMs: 800,
    };
    await manager.runHeadless(config, "thread-notok", "/impl 3", "corp-dispatch-3", 3);
    const call = effects.issueReporter.postCommentCalls[0]!;
    expect(call.body).not.toContain("tokens:");
    expect(call.body).toContain("- duration_ms: 800");
    expect(call.body).toContain("- exit_code: 2");
  });

  test("does not post a report when no issueNumber is given", async () => {
    await manager.runHeadless(config, "thread-noissue", "/impl 1", "corp-dispatch-1");
    expect(effects.issueReporter.postCommentCalls).toHaveLength(0);
  });

  test("report posting failure is fail-soft: the run still completes and the session closes (#289)", async () => {
    effects.issueReporter.failOnPost = true;
    effects.executor.result = {
      exitCode: 0,
      stdout: JSON.stringify({ result: "ok", usage: { output_tokens: 10 } }),
      stderr: "",
      timedOut: false,
      durationMs: 100,
    };
    const res = await manager.runHeadless(config, "thread-soft", "/impl 5", "corp-dispatch-5", 5);
    // The report threw, but the run resolved and the session was closed anyway.
    expect(res.exitCode).toBe(0);
    expect(manager.has("thread-soft")).toBe(false);
    const row = getSessionByClaudeSessionId(res.claudeSessionId);
    expect(row?.status).toBe("stopped");
  });

  test("rejects a duplicate thread (single-flight guard)", async () => {
    await manager.start(config, "dup-thread");
    await expect(
      manager.runHeadless(config, "dup-thread", "/impl 1", "b"),
    ).rejects.toThrow(/既に稼働中/);
  });

  test("surfaces a spawn failure and registers no session (no silent fallback)", async () => {
    const failing = new FakeExecutorAdapter();
    failing.failOnSpawn = true;
    const mgr = new SessionManager({
      effects: { ...createFakeEffects(), executor: failing },
      gracefulKillTimeoutMs: 0,
      probeArtifactsFn: foundArtifactsFn,
    });
    await expect(
      mgr.runHeadless(config, "thread-fail", "/impl 1", "corp-dispatch-1"),
    ).rejects.toThrow(/ENOENT/);
    expect(mgr.count()).toBe(0);
    expect(mgr.has("thread-fail")).toBe(false);
    await mgr.shutdownAll();
  });

  // corp #81 Phase 6 / #298: DISPATCH_CLAUDE_MODEL → headless --model.
  describe("DISPATCH_CLAUDE_MODEL model override (#298)", () => {
    test("resolveDispatchModel trims and treats blank/whitespace as unset", () => {
      expect(resolveDispatchModel({})).toBeUndefined();
      expect(resolveDispatchModel({ DISPATCH_CLAUDE_MODEL: "" })).toBeUndefined();
      expect(resolveDispatchModel({ DISPATCH_CLAUDE_MODEL: "   " })).toBeUndefined();
      expect(
        resolveDispatchModel({ DISPATCH_CLAUDE_MODEL: "claude-opus-4-8" }),
      ).toBe("claude-opus-4-8");
      expect(
        resolveDispatchModel({ DISPATCH_CLAUDE_MODEL: "  claude-opus-4-8  " }),
      ).toBe("claude-opus-4-8");
    });

    test("buildHeadlessClaudeFlags adds --model <value> only when a model is given", () => {
      const withModel = buildHeadlessClaudeFlags(config, "/impl 1", "claude-opus-4-8");
      const i = withModel.indexOf("--model");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(withModel[i + 1]).toBe("claude-opus-4-8");

      // Unset / empty / whitespace-only → no --model (default model, unchanged).
      expect(buildHeadlessClaudeFlags(config, "/impl 1")).not.toContain("--model");
      expect(buildHeadlessClaudeFlags(config, "/impl 1", "")).not.toContain("--model");
      expect(buildHeadlessClaudeFlags(config, "/impl 1", "   ")).not.toContain("--model");
    });

    test("runHeadless passes --model through when DISPATCH_CLAUDE_MODEL is set (fake adapter argv)", async () => {
      const prev = process.env.DISPATCH_CLAUDE_MODEL;
      process.env.DISPATCH_CLAUDE_MODEL = "claude-opus-4-8";
      try {
        await manager.runHeadless(config, "thread-model", "/impl 1", "corp-dispatch-1");
        const call = effects.executor.runHeadlessCalls[0]!;
        const i = call.args.indexOf("--model");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(call.args[i + 1]).toBe("claude-opus-4-8");
      } finally {
        if (prev === undefined) delete process.env.DISPATCH_CLAUDE_MODEL;
        else process.env.DISPATCH_CLAUDE_MODEL = prev;
      }
    });

    test("runHeadless omits --model when DISPATCH_CLAUDE_MODEL is unset (default unchanged)", async () => {
      const prev = process.env.DISPATCH_CLAUDE_MODEL;
      delete process.env.DISPATCH_CLAUDE_MODEL;
      try {
        await manager.runHeadless(config, "thread-nomodel", "/impl 1", "corp-dispatch-1");
        expect(effects.executor.runHeadlessCalls[0]!.args).not.toContain("--model");
      } finally {
        if (prev !== undefined) process.env.DISPATCH_CLAUDE_MODEL = prev;
      }
    });
  });

  // Issue #342: completion probe (Layer 2) + Stop-hook injection (Layer 1).
  describe("headless completion probe (#342)", () => {
    const cleanProbe = () =>
      ({
        ok: true as const,
        value: { pendingTasks: [], pendingWakeup: false, skippedLines: 0 },
      });
    const pendingProbe = () =>
      ({
        ok: true as const,
        value: {
          pendingTasks: [
            {
              toolUseId: "toolu_bg1",
              taskId: "bas5ws1zh",
              source: "timeout_backgrounded" as const,
            },
          ],
          pendingWakeup: false,
          skippedLines: 0,
        },
      });

    function makeManager(
      probe: () => import("../../src/session/pending-work").PendingWorkProbe,
    ): { mgr: SessionManager; fx: FakeSessionEffects } {
      const fx = createFakeEffects();
      const mgr = new SessionManager({
        effects: fx,
        gracefulKillTimeoutMs: 0,
        probePendingWorkFn: probe,
        probeArtifactsFn: foundArtifactsFn,
      });
      return { mgr, fx };
    }

    test("clean run removes the worktree and reports completion: clean", async () => {
      const { mgr, fx } = makeManager(cleanProbe);
      const res = await mgr.runHeadless(config, "t-clean", "/impl 1", "corp-dispatch-1", 1);

      expect(res.completion.status).toBe("clean");
      expect(fx.worktree.removeCalls).toHaveLength(1);
      const report = fx.issueReporter.postCommentCalls[0]!.body;
      expect(report).toContain("- completion: clean");
      expect(report).not.toContain("正常完了と確認できていません");
      await mgr.shutdownAll();
    });

    test("pending run RETAINS the worktree and reports completion: pending (#456 regression)", async () => {
      const { mgr, fx } = makeManager(pendingProbe);
      const res = await mgr.runHeadless(config, "t-pend", "/impl 2", "corp-dispatch-2", 2);

      // exit 0 だが pending — これが 2 例の実測 silent failure の形。
      expect(res.exitCode).toBe(0);
      expect(res.completion.status).toBe("pending");
      expect(res.completion.detail).toContain("bas5ws1zh");
      // Worktree is kept for recovery, session slot is still freed.
      expect(fx.worktree.removeCalls).toHaveLength(0);
      expect(mgr.has("t-pend")).toBe(false);
      const report = fx.issueReporter.postCommentCalls[0]!.body;
      expect(report).toContain("- completion: pending");
      expect(report).toContain("- completion_detail:");
      expect(report).toContain("正常完了と確認できていません");
      await mgr.shutdownAll();
    });

    test("unreadable transcript is fail-loud: completion unknown, worktree retained", async () => {
      const { mgr, fx } = makeManager(() => ({
        ok: false as const,
        error: "transcript unreadable: ENOENT",
      }));
      const res = await mgr.runHeadless(config, "t-unk", "/impl 3", "corp-dispatch-3", 3);

      expect(res.completion.status).toBe("unknown");
      expect(fx.worktree.removeCalls).toHaveLength(0);
      expect(fx.issueReporter.postCommentCalls[0]!.body).toContain("- completion: unknown");
      await mgr.shutdownAll();
    });

    test("a throwing probe degrades to unknown and never leaks the slot (PR #368 review)", async () => {
      const { mgr, fx } = makeManager(() => {
        throw new Error("boom in probe");
      });
      const res = await mgr.runHeadless(config, "t-throw", "/impl 6", "corp-dispatch-6", 6);

      expect(res.completion.status).toBe("unknown");
      expect(res.completion.detail).toContain("boom in probe");
      // Teardown still ran: slot freed, report posted, worktree retained.
      expect(mgr.has("t-throw")).toBe(false);
      expect(mgr.count()).toBe(0);
      expect(fx.issueReporter.postCommentCalls[0]!.body).toContain("- completion: unknown");
      expect(fx.worktree.removeCalls).toHaveLength(0);
      await mgr.shutdownAll();
    });

    test("surviving process group forces pending even when the transcript looks clean", async () => {
      const { mgr, fx } = makeManager(cleanProbe);
      // The fake executor reports pid 20000 via onSpawn; mark its process
      // GROUP (-pid) alive so the orphan probe fires.
      fx.process.alivePids.add(-20000);
      const res = await mgr.runHeadless(config, "t-orphan", "/impl 4", "corp-dispatch-4", 4);

      expect(res.completion.status).toBe("pending");
      expect(res.completion.detail).toContain("プロセスグループ");
      expect(fx.worktree.removeCalls).toHaveLength(0);
      await mgr.shutdownAll();
    });

    test("injects the pending-guard Stop hook via --settings (Layer 1)", async () => {
      const { mgr, fx } = makeManager(cleanProbe);
      await mgr.runHeadless(config, "t-guard", "/impl 5", "corp-dispatch-5");

      const args = fx.executor.runHeadlessCalls[0]!.args;
      const i = args.indexOf("--settings");
      expect(i).toBeGreaterThanOrEqual(0);
      const settings = JSON.parse(args[i + 1]!) as {
        hooks?: { Stop?: { hooks: { type: string; command: string }[] }[] };
      };
      const hook = settings.hooks?.Stop?.[0]?.hooks?.[0];
      expect(hook?.type).toBe("command");
      expect(hook?.command).toContain("headless-pending-guard.ts");
      await mgr.shutdownAll();
    });

    test("HEADLESS_PENDING_GUARD=off disables the Stop-hook injection", () => {
      expect(buildPendingGuardFlags({ HEADLESS_PENDING_GUARD: "off" })).toEqual([]);
      const flags = buildPendingGuardFlags({});
      expect(flags[0]).toBe("--settings");
      expect(flags[1]).toContain("headless-pending-guard.ts");
    });
  });

  // Issue #342 Layer 2 extension: zero-artifact detection. A run can leave no
  // pending signal (completion: clean) and still have delivered nothing — no
  // commit, no PR, no Issue, no comment. That is the remaining silent-failure
  // shape after #368 and must be loud.
  describe("artifact probe (Issue #342 Layer 2 extension)", () => {
    const cleanProbe = () => ({
      ok: true as const,
      value: { pendingTasks: [], pendingWakeup: false, skippedLines: 0 },
    });

    function makeManager(
      artifacts: () => Promise<{
        status: "found" | "none" | "unknown";
        detail: string;
        dirty: boolean;
      }>,
    ): { mgr: SessionManager; fx: FakeSessionEffects } {
      const fx = createFakeEffects();
      const mgr = new SessionManager({
        effects: fx,
        gracefulKillTimeoutMs: 0,
        probePendingWorkFn: cleanProbe,
        probeArtifactsFn: artifacts,
      });
      return { mgr, fx };
    }

    test("found: reports artifacts: found, worktree removed as usual", async () => {
      const { mgr, fx } = makeManager(async () => ({
        status: "found" as const,
        detail: "pr #12",
        dirty: false,
      }));
      const res = await mgr.runHeadless(config, "t-art-found", "/impl 7", "corp-dispatch-7", 7);

      expect(res.artifacts?.status).toBe("found");
      expect(fx.worktree.removeCalls).toHaveLength(1);
      const report = fx.issueReporter.postCommentCalls[0]!.body;
      expect(report).toContain("- artifacts: found");
      expect(report).toContain("- artifacts_detail: pr #12");
      expect(report).not.toContain("成果物（commit / PR / Issue / コメント）を確認できませんでした");
      await mgr.shutdownAll();
    });

    test("none + clean tree: loud in the report, worktree still reclaimed (nothing to recover)", async () => {
      const { mgr, fx } = makeManager(async () => ({
        status: "none" as const,
        detail: "",
        dirty: false,
      }));
      const res = await mgr.runHeadless(config, "t-art-none", "/impl 8", "corp-dispatch-8", 8);

      expect(res.exitCode).toBe(0);
      expect(res.completion.status).toBe("clean");
      expect(res.artifacts?.status).toBe("none");
      // Nothing uncommitted → reclaim (no worktree accumulation on empty runs).
      expect(fx.worktree.removeCalls).toHaveLength(1);
      const report = fx.issueReporter.postCommentCalls[0]!.body;
      expect(report).toContain("- artifacts: none");
      expect(report).toContain("成果物（commit / PR / Issue / コメント）を確認できませんでした");
      await mgr.shutdownAll();
    });

    test("none + dirty tree RETAINS the worktree (abandoned edits, #456 loss mode)", async () => {
      const { mgr, fx } = makeManager(async () => ({
        status: "none" as const,
        detail: "",
        dirty: true,
      }));
      const res = await mgr.runHeadless(config, "t-art-dirty", "/impl 9", "corp-dispatch-9", 9);

      expect(res.artifacts?.status).toBe("none");
      expect(fx.worktree.removeCalls).toHaveLength(0);
      expect(mgr.has("t-art-dirty")).toBe(false);
      await mgr.shutdownAll();
    });

    test("a throwing artifact probe degrades to unknown and never leaks the slot", async () => {
      const { mgr, fx } = makeManager(async () => {
        throw new Error("gh exploded");
      });
      const res = await mgr.runHeadless(config, "t-art-throw", "/impl 10", "corp-dispatch-10", 10);

      expect(res.artifacts?.status).toBe("unknown");
      expect(res.artifacts?.detail).toContain("gh exploded");
      expect(mgr.has("t-art-throw")).toBe(false);
      expect(mgr.count()).toBe(0);
      expect(fx.issueReporter.postCommentCalls[0]!.body).toContain("- artifacts: unknown");
      // The throw path pins dirty:false, which is exactly why unknown must
      // retain (PR #371 review): "could not check" ≠ "safe to reclaim".
      expect(fx.worktree.removeCalls).toHaveLength(0);
      await mgr.shutdownAll();
    });

    test("unknown RETAINS the worktree even with dirty=false (dirty is untrustworthy, PR #371 review)", async () => {
      const { mgr, fx } = makeManager(async () => ({
        status: "unknown" as const,
        detail: "gh pr list: connection refused",
        dirty: false,
      }));
      const res = await mgr.runHeadless(config, "t-art-unk", "/impl 12", "corp-dispatch-12", 12);

      expect(res.artifacts?.status).toBe("unknown");
      expect(fx.worktree.removeCalls).toHaveLength(0);
      await mgr.shutdownAll();
    });

    test("no branch → no artifact probe (nothing to measure without a dispatch worktree)", async () => {
      let called = 0;
      const { mgr } = makeManager(async () => {
        called++;
        return { status: "found" as const, detail: "", dirty: false };
      });
      const res = await mgr.runHeadless(config, "t-art-nobranch", "/impl 11");

      expect(called).toBe(0);
      expect(res.artifacts).toBeUndefined();
      await mgr.shutdownAll();
    });
  });
});
