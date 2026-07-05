import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ORCHESTRATE_PREFIX,
  ORCHESTRATE_RUNNER_COMMAND,
  ORCHESTRATE_BRANCH_PREFIX,
  parseOrchestrateCommand,
  findRunningOrchestrator,
  orchestrateBranchName,
  runOrchestrate,
} from "../../src/session/orchestrate";
import type { OrchestrateSessionManager } from "../../src/session/orchestrate";
import {
  isSenderAllowed,
  loadAccessPolicy,
} from "../../src/config/access-policy";

/**
 * Epic #316 Phase 1 (Issue #318): the `/orchestrate <生引数...>` message command.
 *
 * `parseOrchestrateCommand` is the pure validator: it detects the exact
 * `/orchestrate` token, rejects an empty argument list, extracts a leading
 * `--new` flag, and otherwise preserves the raw argument string verbatim
 * (Supervisor never interprets the arguments — ADR-002 D2).
 *
 * `runOrchestrate` mirrors runDispatch's tmux path: create thread → start
 * session on the `orchestrate-<yyyymmdd-hhmm>` branch → waitForInputReady
 * (best-effort, RW-025/047) → inject `/orchestrate-runner <生引数>`.
 */

// ---------------------------------------------------------------------------
// AC-1: parser (command detection / empty-args error / raw-args fidelity)
// ---------------------------------------------------------------------------

describe("parseOrchestrateCommand", () => {
  test("parses a valid /orchestrate with mixed raw args", () => {
    const r = parseOrchestrateCommand(
      "/orchestrate ~/.claude/sessions/a.tmp agent-base#42 corp の記事を1本書く",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.rawArgs).toBe(
        "~/.claude/sessions/a.tmp agent-base#42 corp の記事を1本書く",
      );
      expect(r.forceNew).toBe(false);
    }
  });

  test("preserves inner whitespace of the raw args verbatim", () => {
    const r = parseOrchestrateCommand("/orchestrate a.tmp    b.tmp  タスク");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.rawArgs).toBe("a.tmp    b.tmp  タスク");
  });

  test("raw args are NOT interpreted: shell metacharacters pass through", () => {
    // 安全性は relay の argv-no-shell 注入経路が担保する。Supervisor は
    // 引数を解釈も変形もしない（ADR-002 D2）。
    const r = parseOrchestrateCommand("/orchestrate `echo x` $(id) ; rm -rf /");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.rawArgs).toBe("`echo x` $(id) ; rm -rf /");
  });

  test("bare /orchestrate (no args) → error (nothing to run)", () => {
    const r = parseOrchestrateCommand("/orchestrate");
    expect(r.kind).toBe("error");
  });

  test("whitespace-only args → error", () => {
    expect(parseOrchestrateCommand("/orchestrate    ").kind).toBe("error");
  });

  test("leading --new is extracted as forceNew and stripped from raw args", () => {
    const r = parseOrchestrateCommand("/orchestrate --new a.tmp b.tmp");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.forceNew).toBe(true);
      expect(r.rawArgs).toBe("a.tmp b.tmp");
    }
  });

  test("--new alone (no tasks) → error", () => {
    expect(parseOrchestrateCommand("/orchestrate --new").kind).toBe("error");
    expect(parseOrchestrateCommand("/orchestrate --new   ").kind).toBe("error");
  });

  test("non-leading --new is left inside the raw args (not a flag)", () => {
    const r = parseOrchestrateCommand("/orchestrate a.tmp --new b.tmp");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.forceNew).toBe(false);
      expect(r.rawArgs).toBe("a.tmp --new b.tmp");
    }
  });

  test("tolerates surrounding whitespace", () => {
    const r = parseOrchestrateCommand("   /orchestrate   タスクA   ");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.rawArgs).toBe("タスクA");
  });

  test("multiline message after the command is kept as raw args", () => {
    const r = parseOrchestrateCommand("/orchestrate\nタスクA\nタスクB");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.rawArgs).toBe("タスクA\nタスクB");
  });

  test("non-orchestrate content → not_orchestrate (falls through)", () => {
    expect(parseOrchestrateCommand("hello").kind).toBe("not_orchestrate");
    expect(parseOrchestrateCommand("/dispatch b 42").kind).toBe(
      "not_orchestrate",
    );
    expect(parseOrchestrateCommand("").kind).toBe("not_orchestrate");
  });

  test("prefix must be the whole token: /orchestrated etc. fall through", () => {
    expect(parseOrchestrateCommand("/orchestrated x").kind).toBe(
      "not_orchestrate",
    );
    expect(parseOrchestrateCommand("/orchestrate-runner x").kind).toBe(
      "not_orchestrate",
    );
    // Phase 2 スキルコマンドを Supervisor が横取りしないこと（契約の分離）。
    expect(ORCHESTRATE_RUNNER_COMMAND.startsWith(ORCHESTRATE_PREFIX)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4: duplicate-launch guard
// ---------------------------------------------------------------------------

describe("findRunningOrchestrator", () => {
  test("finds a running session whose branch has the orchestrate- prefix", () => {
    const hit = findRunningOrchestrator([
      { threadId: "t1", branch: "corp-dispatch-42" },
      { threadId: "t2", branch: "orchestrate-20260705-1200" },
    ]);
    expect(hit?.threadId).toBe("t2");
  });

  test("ignores dispatch/worktree sessions and branchless sessions", () => {
    expect(
      findRunningOrchestrator([
        { threadId: "t1", branch: "corp-dispatch-42" },
        { threadId: "t2", branch: "feat/orchestrate-docs" },
        { threadId: "t3" },
      ]),
    ).toBeUndefined();
  });

  test("empty list → undefined", () => {
    expect(findRunningOrchestrator([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// branch name: orchestrate-<yyyymmdd-hhmm>
// ---------------------------------------------------------------------------

describe("orchestrateBranchName", () => {
  test("formats a given date as orchestrate-<yyyymmdd-hhmm> (local time)", () => {
    const d = new Date(2026, 6, 5, 9, 7); // 2026-07-05 09:07 local
    expect(orchestrateBranchName(d)).toBe("orchestrate-20260705-0907");
  });

  test("matches the guard prefix and the documented shape", () => {
    const name = orchestrateBranchName();
    expect(name.startsWith(ORCHESTRATE_BRANCH_PREFIX)).toBe(true);
    expect(name).toMatch(/^orchestrate-\d{8}-\d{4}$/);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrate (thread → start → waitForInputReady → inject)
// ---------------------------------------------------------------------------

function fakeManager(
  overrides: Partial<{
    start: (
      config: unknown,
      threadId: string,
      branch?: string,
    ) => Promise<unknown>;
    waitForInputReady: (threadId: string) => Promise<boolean>;
    sendMessage: (threadId: string, message: string) => Promise<unknown>;
  }> = {},
): {
  manager: OrchestrateSessionManager;
  startCalls: Array<{ threadId: string; branch?: string }>;
  sendCalls: Array<{ threadId: string; message: string }>;
} {
  const startCalls: Array<{ threadId: string; branch?: string }> = [];
  const sendCalls: Array<{ threadId: string; message: string }> = [];
  const manager: OrchestrateSessionManager = {
    start:
      overrides.start ??
      (async (_config, threadId, branch) => {
        startCalls.push({ threadId, branch });
        return { id: "session-1" };
      }),
    waitForInputReady: overrides.waitForInputReady ?? (async () => true),
    sendMessage:
      overrides.sendMessage ??
      (async (threadId, message) => {
        sendCalls.push({ threadId, message });
        return {};
      }),
  };
  return { manager, startCalls, sendCalls };
}

const config = { channelName: "corp", dir: "/x/corp" };

describe("runOrchestrate", () => {
  test("happy path: thread created, session started on the branch, runner injected with raw args", async () => {
    const { manager, startCalls, sendCalls } = fakeManager();
    let threadBranch: string | undefined;

    const r = await runOrchestrate({
      config,
      branch: "orchestrate-20260705-1200",
      rawArgs: "~/.claude/sessions/a.tmp agent-base#42 記事を書く",
      sessionManager: manager,
      createThread: async (branch) => {
        threadBranch = branch;
        return { id: "thread-orc" };
      },
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.threadId).toBe("thread-orc");
      expect(r.injected).toBe(
        "/orchestrate-runner ~/.claude/sessions/a.tmp agent-base#42 記事を書く",
      );
    }
    expect(threadBranch).toBe("orchestrate-20260705-1200");
    expect(startCalls).toEqual([
      { threadId: "thread-orc", branch: "orchestrate-20260705-1200" },
    ]);
    expect(sendCalls).toEqual([
      {
        threadId: "thread-orc",
        message:
          "/orchestrate-runner ~/.claude/sessions/a.tmp agent-base#42 記事を書く",
      },
    ]);
  });

  test("start runs BEFORE the injected runner command (ordering)", async () => {
    const order: string[] = [];
    const { manager } = fakeManager({
      start: async () => {
        order.push("start");
        return { id: "s" };
      },
      sendMessage: async () => {
        order.push("inject");
        return {};
      },
    });
    await runOrchestrate({
      config,
      branch: "orchestrate-20260705-1200",
      rawArgs: "x",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(order).toEqual(["start", "inject"]);
  });

  test("waitForInputReady=false still injects (best-effort, never a silent drop)", async () => {
    const { manager, sendCalls } = fakeManager({
      waitForInputReady: async () => false,
    });
    const r = await runOrchestrate({
      config,
      branch: "orchestrate-20260705-1200",
      rawArgs: "x",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(true);
    expect(sendCalls).toHaveLength(1);
  });

  test("thread creation failure → ok:false stage=thread, no start/inject", async () => {
    const { manager, startCalls, sendCalls } = fakeManager();
    const r = await runOrchestrate({
      config,
      branch: "orchestrate-20260705-1200",
      rawArgs: "x",
      sessionManager: manager,
      createThread: async () => {
        throw new Error("missing perms");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("thread");
    expect(startCalls).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
  });

  test("session start failure → ok:false stage=start, no inject (no silent fallback)", async () => {
    const { manager, sendCalls } = fakeManager({
      start: async () => {
        throw new Error("最大セッション数に達しています");
      },
    });
    const r = await runOrchestrate({
      config,
      branch: "orchestrate-20260705-1200",
      rawArgs: "x",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("start");
    expect(sendCalls).toHaveLength(0);
  });

  test("inject failure → ok:false stage=inject", async () => {
    const { manager } = fakeManager({
      sendMessage: async () => {
        throw new Error("tmux gone");
      },
    });
    const r = await runOrchestrate({
      config,
      branch: "orchestrate-20260705-1200",
      rawArgs: "x",
      sessionManager: manager,
      createThread: async () => ({ id: "t" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("inject");
  });
});

// ---------------------------------------------------------------------------
// AC-2: authorization fail-closed (evaluateAccess / access.json allowFrom),
// integrated the same way bot.ts's handleOrchestrateMessage wires it:
//   1. isSenderAllowed(loadAccessPolicy(), channelId, userId, isMention)
//   2. parseOrchestrateCommand(content)
//   3. duplicate-launch guard (findRunningOrchestrator)
//   4. runOrchestrate(...)
// ---------------------------------------------------------------------------

const CHANNEL_ID = "846209781206941736";
const OWNER = "111111111111111111";
const OUTSIDER = "999999999999999999";

interface SimResult {
  outcome: "started" | "denied" | "rejected" | "guarded" | "ignored";
  startCalls: Array<{ threadId: string; branch?: string }>;
  sendCalls: Array<{ threadId: string; message: string }>;
}

/** Simulate bot.ts's orchestrate decision sequence for a single message. */
async function simulateOrchestrate(opts: {
  accessPath: string;
  channelId: string;
  userId: string;
  content: string;
  running?: Array<{ threadId: string; branch?: string }>;
}): Promise<SimResult> {
  const { manager, startCalls, sendCalls } = fakeManager();
  const base = { startCalls, sendCalls };

  // Step 1: authorize the sender (fail-closed) — same gate as normal relay
  // messages (allowFrom), independent of the dispatch-only dispatchFrom.
  const decision = isSenderAllowed(
    loadAccessPolicy(opts.accessPath),
    opts.channelId,
    opts.userId,
    /* isMention */ false,
  );
  if (!decision.allowed) return { outcome: "denied", ...base };

  // Step 2: parse.
  const parsed = parseOrchestrateCommand(opts.content);
  if (parsed.kind === "not_orchestrate") return { outcome: "ignored", ...base };
  if (parsed.kind === "error") return { outcome: "rejected", ...base };

  // Step 3: duplicate-launch guard.
  const running = findRunningOrchestrator(opts.running ?? []);
  if (running && !parsed.forceNew) return { outcome: "guarded", ...base };

  // Step 4: run.
  await runOrchestrate({
    config,
    branch: "orchestrate-20260705-1200",
    rawArgs: parsed.rawArgs,
    sessionManager: manager,
    createThread: async () => ({ id: "thread-orc" }),
  });
  return { outcome: "started", ...base };
}

describe("orchestrate integration (auth -> parse -> guard -> run)", () => {
  let dir: string;
  let accessPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orchestrate-int-"));
    accessPath = join(dir, "access.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePolicy(allowFrom: string[]): void {
    writeFileSync(
      accessPath,
      JSON.stringify({
        groups: {
          [CHANNEL_ID]: { requireMention: false, allowFrom },
        },
      }),
    );
  }

  test("allowFrom sender starts the orchestrator and injects the runner", async () => {
    writePolicy([OWNER]);
    const r = await simulateOrchestrate({
      accessPath,
      channelId: CHANNEL_ID,
      userId: OWNER,
      content: "/orchestrate a.tmp b.tmp",
    });
    expect(r.outcome).toBe("started");
    expect(r.sendCalls).toEqual([
      { threadId: "thread-orc", message: "/orchestrate-runner a.tmp b.tmp" },
    ]);
  });

  test("sender outside allowFrom is denied: no session, no injection (AC-2)", async () => {
    writePolicy([OWNER]);
    const r = await simulateOrchestrate({
      accessPath,
      channelId: CHANNEL_ID,
      userId: OUTSIDER,
      content: "/orchestrate a.tmp",
    });
    expect(r.outcome).toBe("denied");
    expect(r.startCalls).toHaveLength(0);
    expect(r.sendCalls).toHaveLength(0);
  });

  test("missing policy file denies (fail-closed)", async () => {
    const r = await simulateOrchestrate({
      accessPath: join(dir, "does-not-exist.json"),
      channelId: CHANNEL_ID,
      userId: OWNER,
      content: "/orchestrate a.tmp",
    });
    expect(r.outcome).toBe("denied");
    expect(r.startCalls).toHaveLength(0);
  });

  test("channel not configured in the policy denies (fail-closed)", async () => {
    writePolicy([OWNER]);
    const r = await simulateOrchestrate({
      accessPath,
      channelId: "123456789012345678",
      userId: OWNER,
      content: "/orchestrate a.tmp",
    });
    expect(r.outcome).toBe("denied");
    expect(r.startCalls).toHaveLength(0);
  });

  test("running orchestrator blocks a second launch (AC-4)", async () => {
    writePolicy([OWNER]);
    const r = await simulateOrchestrate({
      accessPath,
      channelId: CHANNEL_ID,
      userId: OWNER,
      content: "/orchestrate c.tmp",
      running: [{ threadId: "t-live", branch: "orchestrate-20260705-1100" }],
    });
    expect(r.outcome).toBe("guarded");
    expect(r.startCalls).toHaveLength(0);
    expect(r.sendCalls).toHaveLength(0);
  });

  test("--new bypasses the duplicate-launch guard explicitly (AC-4)", async () => {
    writePolicy([OWNER]);
    const r = await simulateOrchestrate({
      accessPath,
      channelId: CHANNEL_ID,
      userId: OWNER,
      content: "/orchestrate --new c.tmp",
      running: [{ threadId: "t-live", branch: "orchestrate-20260705-1100" }],
    });
    expect(r.outcome).toBe("started");
    expect(r.sendCalls).toEqual([
      { threadId: "thread-orc", message: "/orchestrate-runner c.tmp" },
    ]);
  });

  test("empty args are rejected before any session work (AC-1)", async () => {
    writePolicy([OWNER]);
    const r = await simulateOrchestrate({
      accessPath,
      channelId: CHANNEL_ID,
      userId: OWNER,
      content: "/orchestrate",
    });
    expect(r.outcome).toBe("rejected");
    expect(r.startCalls).toHaveLength(0);
  });
});
