import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  SessionManager,
  buildHeadlessClaudeFlags,
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
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0 });
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
});
