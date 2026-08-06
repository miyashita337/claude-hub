import { describe, test, expect } from "bun:test";
import {
  runDispatch,
  resolveExecutorMode,
  type DispatchSessionManager,
  type DispatchHeadlessOutcome,
} from "../../src/session/dispatch";

/**
 * Epic #285 Phase 2 / #287: the headless opt-in branch of runDispatch. Verifies
 * the env gate (resolveExecutorMode), that stdout is formatted and posted to the
 * thread (AC-2), that a non-zero exit / timeout / empty output are each surfaced
 * explicitly (AC-5, no silent success), and that a missing wire fails closed.
 */

const config = { channelName: "agent-base", dir: "/x/agent-base" };

/** A headless-capable fake manager + captured posts. */
function harness(
  outcome: DispatchHeadlessOutcome | (() => Promise<DispatchHeadlessOutcome>),
) {
  const runHeadlessCalls: Array<{
    threadId: string;
    initialCommand: string;
    branch?: string;
    issueNumber?: number;
  }> = [];
  const posts: Array<{ threadId: string; content: string }> = [];
  const manager: DispatchSessionManager = {
    start: async () => ({}),
    waitForInputReady: async () => true,
    sendMessage: async () => ({}),
    runHeadless: async (_c, threadId, initialCommand, branch, issueNumber) => {
      runHeadlessCalls.push({ threadId, initialCommand, branch, issueNumber });
      return typeof outcome === "function" ? outcome() : outcome;
    },
  };
  return { manager, runHeadlessCalls, posts };
}

describe("resolveExecutorMode", () => {
  test("defaults to tmux; only the exact 'headless' string opts in", () => {
    expect(resolveExecutorMode({})).toBe("tmux");
    expect(resolveExecutorMode({ DISPATCH_EXECUTOR_MODE: "headless" })).toBe(
      "headless",
    );
    expect(resolveExecutorMode({ DISPATCH_EXECUTOR_MODE: "tmux" })).toBe("tmux");
    expect(resolveExecutorMode({ DISPATCH_EXECUTOR_MODE: "HEADLESS" })).toBe(
      "tmux",
    );
    expect(resolveExecutorMode({ DISPATCH_EXECUTOR_MODE: "" })).toBe("tmux");
  });
});

describe("runDispatch headless", () => {
  test("posts start notice + formatted stdout, returns mode=headless (AC-2)", async () => {
    const { manager, runHeadlessCalls, posts } = harness({
      exitCode: 0,
      stdout: "PR: https://github.com/x/y/pull/1",
      stderr: "",
      timedOut: false,
    });
    const r = await runDispatch({
      config,
      branch: "corp-dispatch-42",
      issueNumber: 42,
      command: "impl",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "thread-h" }),
      postToThread: async (threadId, content) => {
        posts.push({ threadId, content });
      },
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("headless");
      expect(r.threadId).toBe("thread-h");
      expect(r.injected).toBe("/impl 42");
      expect(r.exitCode).toBe(0);
      expect(r.timedOut).toBe(false);
    }
    expect(runHeadlessCalls).toEqual([
      {
        threadId: "thread-h",
        initialCommand: "/impl 42",
        branch: "corp-dispatch-42",
        // issueNumber threaded through so the manager posts the report (#289).
        issueNumber: 42,
      },
    ]);
    // A start notice, then the stdout, both to the created thread.
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[0]!.content).toContain("/impl 42");
    expect(posts.some((p) => p.content.includes("pull/1"))).toBe(true);
    expect(posts.every((p) => p.threadId === "thread-h")).toBe(true);
  });

  test("non-zero exit is surfaced as an error with exit code + stderr (AC-5)", async () => {
    const { manager, posts } = harness({
      exitCode: 2,
      stdout: "partial log",
      stderr: "fatal: boom",
      timedOut: false,
    });
    const r = await runDispatch({
      config,
      branch: "corp-dispatch-9",
      issueNumber: 9,
      command: "pdca",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "t9" }),
      postToThread: async (threadId, content) => {
        posts.push({ threadId, content });
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.exitCode).toBe(2);
    const joined = posts.map((p) => p.content).join("\n");
    expect(joined).toContain("非ゼロ終了");
    expect(joined).toContain("exit 2");
    expect(joined).toContain("boom");
  });

  test("timeout is surfaced explicitly", async () => {
    const { manager, posts } = harness({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    await runDispatch({
      config,
      branch: "corp-dispatch-3",
      issueNumber: 3,
      command: "impl",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "t3" }),
      postToThread: async (threadId, content) => {
        posts.push({ threadId, content });
      },
    });
    expect(posts.map((p) => p.content).join("\n")).toContain("タイムアウト");
  });

  test("exit 0 with empty stdout is flagged, never presented as silent success", async () => {
    const { manager, posts } = harness({
      exitCode: 0,
      stdout: "   \n",
      stderr: "",
      timedOut: false,
    });
    await runDispatch({
      config,
      branch: "corp-dispatch-5",
      issueNumber: 5,
      command: "impl",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "t5" }),
      postToThread: async (threadId, content) => {
        posts.push({ threadId, content });
      },
    });
    expect(posts.map((p) => p.content).join("\n")).toContain("stdout が空");
  });

  test("fails closed when the manager cannot run headless (no silent tmux fallback)", async () => {
    // A tmux-only manager (no runHeadless).
    const tmuxOnly: DispatchSessionManager = {
      start: async () => ({}),
      waitForInputReady: async () => true,
      sendMessage: async () => ({}),
    };
    const r = await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: tmuxOnly,
      executorMode: "headless",
      createThread: async () => ({ id: "t" }),
      postToThread: async () => {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("start");
      expect(r.error).toContain("not wired");
    }
  });

  test("spawn failure surfaces to the thread and the caller (stage=start)", async () => {
    const posts: string[] = [];
    const manager: DispatchSessionManager = {
      start: async () => ({}),
      waitForInputReady: async () => true,
      sendMessage: async () => ({}),
      runHeadless: async () => {
        throw new Error("spawn claude ENOENT");
      },
    };
    const r = await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "t" }),
      postToThread: async (_id, c) => {
        posts.push(c);
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("start");
    expect(posts.join("\n")).toContain("開始できませんでした");
  });

  test("output posting failure is reported as stage=output", async () => {
    const { manager } = harness({
      exitCode: 0,
      stdout: "some output",
      stderr: "",
      timedOut: false,
    });
    let calls = 0;
    const r = await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "t" }),
      postToThread: async () => {
        // Let the start notice through, fail on the output chunk.
        calls += 1;
        if (calls >= 2) throw new Error("discord 500");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("output");
  });

  test("thread creation failure short-circuits before running headless", async () => {
    const { manager, runHeadlessCalls } = harness({
      exitCode: 0,
      stdout: "x",
      stderr: "",
      timedOut: false,
    });
    const r = await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => {
        throw new Error("missing perms");
      },
      postToThread: async () => {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("thread");
    expect(runHeadlessCalls).toHaveLength(0);
  });

  test("default (no executorMode) still uses the tmux path (AC-4)", async () => {
    const sent: string[] = [];
    const manager: DispatchSessionManager = {
      start: async () => ({}),
      waitForInputReady: async () => true,
      sendMessage: async (_t, m) => {
        sent.push(m);
        return {};
      },
      // runHeadless present but must NOT be used when mode is unset/tmux.
      runHeadless: async () => {
        throw new Error("headless must not run in tmux mode");
      },
    };
    const r = await runDispatch({
      config,
      branch: "corp-dispatch-1",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mode).toBe("tmux");
    expect(sent).toEqual(["/impl 1"]);
  });
});

// Issue #342: pending/unknown completion is warned in the thread even on exit 0.
describe("headless completion warning (#342)", () => {
  test("exit 0 + completion pending posts the ⚠️ pending warning", async () => {
    const { manager } = harness({
      exitCode: 0,
      stdout: "作業中の報告テキスト",
      stderr: "",
      timedOut: false,
      completion: {
        status: "pending",
        detail: "未完了の背景タスク 1 件 (bas5ws1zh)",
      },
    });
    const posts: string[] = [];
    const r = await runDispatch({
      config,
      branch: "b",
      issueNumber: 456,
      command: "pdca",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "t" }),
      postToThread: async (_id, c) => {
        posts.push(c);
      },
    });
    expect(r.ok).toBe(true);
    const all = posts.join("\n");
    expect(all).toContain("正常完了と確認できていません");
    expect(all).toContain("completion: pending");
    expect(all).toContain("bas5ws1zh");
    expect(all).toContain("worktree は復旧用に保全");
  });

  test("completion unknown also warns (fail-loud)", async () => {
    const { manager } = harness({
      exitCode: 0,
      stdout: "done",
      stderr: "",
      timedOut: false,
      completion: { status: "unknown", detail: "transcript 検証不能 (ENOENT)" },
    });
    const posts: string[] = [];
    await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "t" }),
      postToThread: async (_id, c) => {
        posts.push(c);
      },
    });
    expect(posts.join("\n")).toContain("completion: unknown");
  });

  test("completion clean posts no warning; absent completion stays pre-#342 silent", async () => {
    for (const completion of [
      { status: "clean" as const, detail: "" },
      undefined,
    ]) {
      const { manager } = harness({
        exitCode: 0,
        stdout: "done",
        stderr: "",
        timedOut: false,
        completion,
      });
      const posts: string[] = [];
      await runDispatch({
        config,
        branch: "b",
        issueNumber: 1,
        command: "impl",
        sessionManager: manager,
        executorMode: "headless",
        createThread: async () => ({ id: "t" }),
        postToThread: async (_id, c) => {
          posts.push(c);
        },
      });
      expect(posts.join("\n")).not.toContain("正常完了と確認できていません");
    }
  });
});

// Issue #342 Layer 2 extension: zero artifacts is warned in the thread even on
// exit 0 + clean completion ("finished cleanly but delivered nothing").
describe("headless artifact warning (#342 Layer 2 extension)", () => {
  async function run(artifacts: DispatchHeadlessOutcome["artifacts"]) {
    const { manager } = harness({
      exitCode: 0,
      stdout: "done",
      stderr: "",
      timedOut: false,
      completion: { status: "clean", detail: "" },
      artifacts,
    });
    const posts: string[] = [];
    await runDispatch({
      config,
      branch: "b",
      issueNumber: 1,
      command: "impl",
      sessionManager: manager,
      executorMode: "headless",
      createThread: async () => ({ id: "t" }),
      postToThread: async (_id, c) => {
        posts.push(c);
      },
    });
    return posts.join("\n");
  }

  test("artifacts none posts the ⚠️ zero-artifact warning even on clean completion", async () => {
    const all = await run({ status: "none", detail: "", dirty: false });
    expect(all).toContain("成果物（commit / PR / Issue / コメント）を確認できませんでした");
    expect(all).toContain("artifacts: none");
    expect(all).not.toContain("未 commit の変更");
  });

  test("artifacts none + dirty mentions the retained worktree", async () => {
    const all = await run({ status: "none", detail: "", dirty: true });
    expect(all).toContain("未 commit の変更が worktree に残っている");
  });

  test("artifacts unknown also warns (fail-loud)", async () => {
    const all = await run({
      status: "unknown",
      detail: "gh pr list: connection refused",
      dirty: false,
    });
    expect(all).toContain("artifacts: unknown");
    expect(all).toContain("connection refused");
  });

  test("artifacts found / absent posts no artifact warning", async () => {
    for (const artifacts of [
      { status: "found" as const, detail: "pr #12", dirty: false },
      undefined,
    ]) {
      const all = await run(artifacts);
      expect(all).not.toContain("成果物（commit / PR / Issue / コメント）を確認できませんでした");
    }
  });
});
