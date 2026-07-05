import { test, expect, describe } from "bun:test";
import { CHANNEL_MAP } from "../../src/config/channels";
import {
  HUB_WORK_CHANNEL_NAME,
  HUB_WORK_PARENT_CHANNEL,
  buildHubWorkConfig,
  parseHubWorkRequest,
  runHubWork,
  type HubWorkQueue,
  type HubWorkSessionManager,
  type RunHubWorkArgs,
} from "../../src/session/hub-work";
import type { QueuedDispatch } from "../../src/session/dispatch-queue";

/**
 * Epic #316 Phase 3 (#320, ADR-002 D5) — claude-hub work セッション経路。
 *
 * 絶対ルール（CHANNEL_MAP に claude-hub を追加しない）を保ったまま、
 * ephemeral config の明示渡しで dispatch 相当の起動ができることを検証する。
 */

describe("FATAL guard 非接触 (ADR-002 D5-1, AC-4)", () => {
  test("CHANNEL_MAP に claude-hub が存在しない（guard が生きたまま import 成功）", () => {
    // channels.ts の import が throw しなかった時点で FATAL guard は green。
    expect(CHANNEL_MAP.has("claude-hub")).toBe(false);
  });

  test("ephemeral work config は CHANNEL_MAP に登録されない", () => {
    // buildHubWorkConfig を呼んでも CHANNEL_MAP は不変（登録禁止 contract）。
    buildHubWorkConfig();
    expect(CHANNEL_MAP.has(HUB_WORK_CHANNEL_NAME)).toBe(false);
    expect(CHANNEL_MAP.has("claude-hub")).toBe(false);
  });

  test("work スレッドの親チャンネルは corp（ADR-002 D5-3）で、corp は既存登録済み", () => {
    expect(HUB_WORK_PARENT_CHANNEL).toBe("corp");
    expect(CHANNEL_MAP.has("corp")).toBe(true);
  });
});

describe("buildHubWorkConfig", () => {
  test("cwd は <home>/claude-hub、channel 名は claude-hub-work", () => {
    const config = buildHubWorkConfig("/Users/testuser");
    expect(config.channelName).toBe(HUB_WORK_CHANNEL_NAME);
    expect(config.dir).toBe("/Users/testuser/claude-hub");
    expect(config.displayName).toBe("Claude Hub Work");
  });

  test("channel 名は FATAL guard の検査対象文字列そのものではない", () => {
    // guard は文字列 "claude-hub" の完全一致で検査する（channels.ts:141）。
    expect(HUB_WORK_CHANNEL_NAME).not.toBe("claude-hub");
  });
});

describe("parseHubWorkRequest（fail-closed、/dispatch パーサと同一検証）", () => {
  test("selector 省略 → impl", () => {
    const parsed = parseHubWorkRequest({ branch: "feat-320", issueNumber: 320 });
    expect(parsed).toEqual({
      kind: "ok",
      branch: "feat-320",
      issueNumber: 320,
      command: "impl",
    });
  });

  test("selector pdca → pdca", () => {
    const parsed = parseHubWorkRequest({
      branch: "corp-dispatch-320",
      issueNumber: 320,
      selector: "pdca",
    });
    expect(parsed).toEqual({
      kind: "ok",
      branch: "corp-dispatch-320",
      issueNumber: 320,
      command: "pdca",
    });
  });

  test("selector no-template → impl に collapse", () => {
    const parsed = parseHubWorkRequest({
      branch: "b",
      issueNumber: 1,
      selector: "no-template",
    });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.command).toBe("impl");
  });

  test.each([
    ["null body", null],
    ["array body", [1, 2]],
    ["string body", "hi" as unknown],
  ])("非オブジェクト body は error: %s", (_label, body) => {
    expect(parseHubWorkRequest(body).kind).toBe("error");
  });

  test.each([
    ["空 branch", ""],
    ["空白入り branch", "feat 320"],
    ["シェルメタ文字 branch（二重引用符）", 'a"b'],
    ["シェルメタ文字 branch（backtick）", "a`b"],
    ["シェルメタ文字 branch（$）", "a$b"],
    ["path traversal branch", "../etc"],
  ])("不正 branch は error: %s", (_label, branch) => {
    expect(parseHubWorkRequest({ branch, issueNumber: 1 }).kind).toBe("error");
  });

  test.each([
    ["文字列 issueNumber", "320" as unknown],
    ["ゼロ", 0],
    ["負数", -1],
    ["小数", 1.5],
  ])("不正 issueNumber は error: %s", (_label, issueNumber) => {
    expect(parseHubWorkRequest({ branch: "b", issueNumber }).kind).toBe("error");
  });

  test("selector は閉集合（未知トークンは推測せず拒否）", () => {
    const parsed = parseHubWorkRequest({
      branch: "b",
      issueNumber: 1,
      selector: "yolo",
    });
    expect(parsed.kind).toBe("error");
  });
});

/** run() を即時 inline 実行する fake queue（決定的にアサートするため）。 */
function inlineQueue(): HubWorkQueue & { submitted: QueuedDispatch[] } {
  const submitted: QueuedDispatch[] = [];
  return {
    submitted,
    limit: () => 3,
    submit: async (item) => {
      submitted.push(item);
      await item.run();
      return "started";
    },
  };
}

interface FakeManagerCalls {
  start: Array<{ config: unknown; threadId: string; branch?: string }>;
  sendMessage: Array<{ threadId: string; message: string }>;
}

function fakeManager(opts?: { startError?: Error }): HubWorkSessionManager & {
  calls: FakeManagerCalls;
} {
  const calls: FakeManagerCalls = { start: [], sendMessage: [] };
  return {
    calls,
    start: async (config, threadId, branch) => {
      if (opts?.startError) throw opts.startError;
      calls.start.push({ config, threadId, branch });
      return {};
    },
    waitForInputReady: async () => true,
    sendMessage: async (threadId, message) => {
      calls.sendMessage.push({ threadId, message });
      return {};
    },
    listRunningByChannel: () => [],
    count: () => 1,
  };
}

function baseArgs(overrides: Partial<RunHubWorkArgs> = {}): RunHubWorkArgs & {
  posts: Array<{ threadId: string; content: string }>;
  threads: string[];
} {
  const posts: Array<{ threadId: string; content: string }> = [];
  const threads: string[] = [];
  return {
    posts,
    threads,
    body: { branch: "feat-320", issueNumber: 320, selector: "pdca" },
    sessionManager: fakeManager(),
    queue: inlineQueue(),
    createThread: async (name) => {
      threads.push(name);
      return { id: "T1" };
    },
    postToThread: async (threadId, content) => {
      posts.push({ threadId, content });
    },
    config: buildHubWorkConfig("/tmp/hub-work-test-home"),
    dirExists: () => true,
    ...overrides,
  };
}

describe("runHubWork", () => {
  test("happy path: corp スレッド作成 → ephemeral config 明示渡しで start → selector 注入", async () => {
    const manager = fakeManager();
    const args = baseArgs({ sessionManager: manager });
    const result = await runHubWork(args);

    expect(result).toEqual({
      ok: true,
      threadId: "T1",
      queued: false,
      injected: "/pdca 320",
    });

    // スレッド名は既存 dispatch と同じ規約（branch + displayName）。
    expect(args.threads).toHaveLength(1);
    expect(args.threads[0]).toContain("feat-320");
    expect(args.threads[0]).toContain("Claude Hub Work");

    // start は CHANNEL_MAP を経由しない ephemeral config が明示渡しされる。
    expect(manager.calls.start).toHaveLength(1);
    const startCall = manager.calls.start[0]!;
    expect(startCall.threadId).toBe("T1");
    expect(startCall.branch).toBe("feat-320");
    const passedConfig = startCall.config as { channelName: string; dir: string };
    expect(passedConfig.channelName).toBe(HUB_WORK_CHANNEL_NAME);
    expect(passedConfig.dir).toBe("/tmp/hub-work-test-home/claude-hub");

    // 初期コマンドは既存 dispatch と同一の注入形。
    expect(manager.calls.sendMessage).toEqual([
      { threadId: "T1", message: "/pdca 320" },
    ]);

    // welcome がスレッドへ投稿される。
    expect(args.posts.some((p) => p.content.includes("work セッション経路で起動"))).toBe(
      true,
    );
  });

  test("body 不正 → 400（スレッドは作られない）", async () => {
    const args = baseArgs({ body: { branch: 'a"b', issueNumber: 1 } });
    const result = await runHubWork(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(args.threads).toHaveLength(0);
  });

  test("claude-hub リポ不在 → 500（スレッドは作られない）", async () => {
    const args = baseArgs({ dirExists: () => false });
    const result = await runHubWork(args);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("claude-hub");
    }
    expect(args.threads).toHaveLength(0);
  });

  test("スレッド作成失敗 → 500", async () => {
    const args = baseArgs({
      createThread: async () => {
        throw new Error("no corp channel");
      },
    });
    const result = await runHubWork(args);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("no corp channel");
    }
  });

  test("start 失敗 → run() は false（スロット即時解放契約）+ スレッドへ失敗を明示", async () => {
    const manager = fakeManager({ startError: new Error("boom") });
    let runReturned: boolean | undefined;
    const queue: HubWorkQueue = {
      limit: () => 3,
      submit: async (item) => {
        runReturned = await item.run();
        return "started";
      },
    };
    const args = baseArgs({ sessionManager: manager, queue });
    const result = await runHubWork(args);
    // submit 自体は受理される（既存 dispatch と同じ: 失敗はスレッドで報告）。
    expect(result.ok).toBe(true);
    expect(runReturned).toBe(false);
    expect(args.posts.some((p) => p.content.includes("起動に失敗"))).toBe(true);
  });

  test("上限超過: queued=true で onQueued の待機通知が届く", async () => {
    const queue: HubWorkQueue = {
      limit: () => 3,
      submit: async (item) => {
        await item.onQueued(2);
        return "queued"; // スロットが空くまで run() は走らない
      },
    };
    const args = baseArgs({ queue });
    const result = await runHubWork(args);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.queued).toBe(true);
    expect(args.posts.some((p) => p.content.includes("待機中"))).toBe(true);
  });

  test("admissionGate はスロット獲得後・start 前に await される", async () => {
    const order: string[] = [];
    const manager = fakeManager();
    const origStart = manager.start.bind(manager);
    manager.start = async (config, threadId, branch) => {
      order.push("start");
      return origStart(config, threadId, branch);
    };
    const args = baseArgs({
      sessionManager: manager,
      admissionGate: async () => {
        order.push("gate");
      },
    });
    await runHubWork(args);
    expect(order).toEqual(["gate", "start"]);
  });
});
