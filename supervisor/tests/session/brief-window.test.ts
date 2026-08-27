import { describe, test, expect } from "bun:test";
import {
  BRIEF_WINDOW_DISABLED_ENV,
  briefWindowBranch,
  briefWindowInitialCommand,
  briefWindowThreadName,
  BRIEF_WINDOW_DISABLED_NOTICE,
  BRIEF_WINDOW_EMPTY_REPLY_NOTICE,
  BRIEF_WINDOW_NO_CONFIG_NOTICE,
  BRIEF_WINDOW_REPLY_ERROR_NOTICE,
  BRIEF_WINDOW_RESTART_NOTICE,
  createBriefWindowDeps,
  evaluateBriefWindowOpen,
  evaluateBriefWindowRestart,
  isBriefWindowDisabled,
  handleBriefWindowThreadMessage,
  openBriefWindow,
  openBriefWindowForBrief,
  parseBriefWindowThreadName,
  type BriefWindowDeps,
} from "../../src/session/brief-window";

/**
 * Issue #454: the morning brief opens ONE conversation window (thread +
 * session) in #corp so the chairman can reply with something other than the
 * decision buttons.
 *
 * The properties fixed here are the ones that keep the window from becoming
 * either a saturation source or an approval-gate bypass:
 *
 *   1. **no free text** — the injected command is built from the already
 *      validated `YYYY-MM-DD` token and a fixed literal, never from caller text
 *      (same invariant as #449);
 *   2. **idempotent** — a second `/brief` for the same business day reuses the
 *      existing window instead of opening a second one;
 *   3. **never silent** — a capacity refusal or a start failure is reported,
 *      and it never takes the decision buttons down with it.
 */

const DATE = "2026-08-26";

/** CEO が起動直後に返す待機報告の代表（corp#136 の 1 行）。 */
const STANDBY =
  "窓口開いてます — 未決提案 1 件 / 会長判断待ち 10 件。決裁はボタン、それ以外はここへどうぞ。";

function deps(over: Partial<BriefWindowDeps> = {}) {
  const calls = {
    created: [] as string[],
    started: [] as Array<{ threadId: string; branch: string }>,
    sent: [] as Array<{ threadId: string; text: string }>,
    thread: [] as Array<{ threadId: string; content: string }>,
    channel: [] as string[],
    failures: [] as Array<{ title: string; body: string }>,
  };
  const base: BriefWindowDeps = {
    findThreadByName: async () => null,
    hasSession: () => false,
    createThread: async (name) => {
      calls.created.push(name);
      return { id: "thread-new" };
    },
    start: async (threadId, branch) => {
      calls.started.push({ threadId, branch });
    },
    waitForInputReady: async () => true,
    sendMessage: async (threadId, text) => {
      calls.sent.push({ threadId, text });
      return { chunks: [STANDBY] };
    },
    postToThread: async (threadId, content) => {
      calls.thread.push({ threadId, content });
    },
    postToChannel: async (content) => {
      calls.channel.push(content);
    },
    notifyFailure: async (title, body) => {
      calls.failures.push({ title, body });
    },
  };
  return { deps: { ...base, ...over }, calls };
}

describe("naming contract", () => {
  test("thread name / branch / injected command are derived from the date alone", () => {
    expect(briefWindowThreadName(DATE)).toBe(`朝レポ窓口 ${DATE}`);
    expect(briefWindowBranch(DATE)).toBe(`corp-brief-window-${DATE}`);
    expect(briefWindowInitialCommand(DATE)).toBe(`/brief-window ${DATE}`);
  });

  test("the injected command carries no caller text beyond the validated date", () => {
    // A date that already failed validation upstream must not reach the pane.
    expect(() => briefWindowInitialCommand("2026-08-26; rm -rf /")).toThrow();
    expect(() => briefWindowThreadName("../evil")).toThrow();
    expect(() => briefWindowBranch("$(whoami)")).toThrow();
  });

  test("a window thread is recognised by its name and yields back the date", () => {
    expect(parseBriefWindowThreadName(`朝レポ窓口 ${DATE}`)).toBe(DATE);
    expect(parseBriefWindowThreadName("朝レポ窓口")).toBeNull();
    expect(parseBriefWindowThreadName("朝レポ窓口 not-a-date")).toBeNull();
    expect(parseBriefWindowThreadName("corp-dispatch-12 Corp CEO 1")).toBeNull();
    expect(parseBriefWindowThreadName(null)).toBeNull();
  });
});

describe("kill-switch", () => {
  test("is independent of the decision path's own switch", () => {
    expect(BRIEF_WINDOW_DISABLED_ENV).toBe("CORP_BRIEF_WINDOW_DISABLED");
    expect(isBriefWindowDisabled({})).toBe(false);
    expect(isBriefWindowDisabled({ CORP_BRIEF_WINDOW_DISABLED: "" })).toBe(false);
    expect(isBriefWindowDisabled({ CORP_BRIEF_WINDOW_DISABLED: "0" })).toBe(false);
    expect(isBriefWindowDisabled({ CORP_BRIEF_WINDOW_DISABLED: "1" })).toBe(true);
    // The decision path's switch must NOT take the window down with it.
    expect(isBriefWindowDisabled({ CORP_BRIEF_DISABLED: "1" })).toBe(false);
  });
});

describe("evaluateBriefWindowOpen", () => {
  const ok = { date: DATE, hasBriefConfig: true, sessionCount: 3, maxSessions: 10 };

  test("opens for a brief-configured channel with capacity", () => {
    const d = evaluateBriefWindowOpen(ok);
    expect(d.kind).toBe("open");
    if (d.kind !== "open") return;
    expect(d.threadName).toBe(`朝レポ窓口 ${DATE}`);
    expect(d.branch).toBe(`corp-brief-window-${DATE}`);
    expect(d.command).toBe(`/brief-window ${DATE}`);
  });

  test("skips when the kill-switch is set", () => {
    const d = evaluateBriefWindowOpen({ ...ok, env: { CORP_BRIEF_WINDOW_DISABLED: "1" } });
    expect(d).toEqual({ kind: "skip", reason: "disabled" });
  });

  test("skips a channel without brief config (fail-closed, same rule as the decision path)", () => {
    expect(evaluateBriefWindowOpen({ ...ok, hasBriefConfig: false })).toEqual({
      kind: "skip",
      reason: "no_brief_config",
    });
  });

  test("skips an invalid date rather than interpolating it", () => {
    expect(evaluateBriefWindowOpen({ ...ok, date: "2026/08/26" })).toEqual({
      kind: "skip",
      reason: "invalid_date",
    });
  });

  test("skips at the session cap", () => {
    expect(evaluateBriefWindowOpen({ ...ok, sessionCount: 10 })).toEqual({
      kind: "skip",
      reason: "capacity",
    });
  });
});

describe("evaluateBriefWindowRestart", () => {
  const ok = {
    threadName: `朝レポ窓口 ${DATE}`,
    hasBriefConfig: true,
    hasSession: false,
    sessionCount: 2,
    maxSessions: 10,
  };

  test("restarts a reaped window thread", () => {
    const d = evaluateBriefWindowRestart(ok);
    expect(d.kind).toBe("restart");
    if (d.kind !== "restart") return;
    expect(d.date).toBe(DATE);
    expect(d.branch).toBe(`corp-brief-window-${DATE}`);
  });

  test("leaves non-window threads to the existing salvage path", () => {
    expect(evaluateBriefWindowRestart({ ...ok, threadName: "corp-dispatch-12" })).toEqual({
      kind: "skip",
      reason: "not_window_thread",
    });
  });

  test("does nothing when the session is still alive", () => {
    expect(evaluateBriefWindowRestart({ ...ok, hasSession: true })).toEqual({
      kind: "skip",
      reason: "session_alive",
    });
  });

  test("is fail-closed on channel config, kill-switch and capacity", () => {
    expect(evaluateBriefWindowRestart({ ...ok, hasBriefConfig: false })).toEqual({
      kind: "skip",
      reason: "no_brief_config",
    });
    expect(
      evaluateBriefWindowRestart({ ...ok, env: { CORP_BRIEF_WINDOW_DISABLED: "1" } }),
    ).toEqual({ kind: "skip", reason: "disabled" });
    expect(evaluateBriefWindowRestart({ ...ok, sessionCount: 10 })).toEqual({
      kind: "skip",
      reason: "capacity",
    });
  });
});

describe("openBriefWindow", () => {
  test("creates the thread, starts the session and injects the fixed command", async () => {
    const { deps: d, calls } = deps();
    const res = await openBriefWindow(
      { date: DATE, hasBriefConfig: true, sessionCount: 1, maxSessions: 10 },
      d,
    );

    expect(res).toEqual({ ok: true, threadId: "thread-new", reused: false });
    expect(calls.created).toEqual([`朝レポ窓口 ${DATE}`]);
    expect(calls.started).toEqual([
      { threadId: "thread-new", branch: `corp-brief-window-${DATE}` },
    ]);
    expect(calls.sent).toEqual([
      { threadId: "thread-new", text: `/brief-window ${DATE}` },
    ]);
    expect(calls.failures).toEqual([]);
  });

  test("AC-3: a second brief for the same day reuses the live window instead of opening a second one", async () => {
    const { deps: d, calls } = deps({
      findThreadByName: async (name) =>
        name === `朝レポ窓口 ${DATE}` ? { id: "thread-existing" } : null,
      hasSession: (id) => id === "thread-existing",
    });

    const res = await openBriefWindow(
      { date: DATE, hasBriefConfig: true, sessionCount: 1, maxSessions: 10 },
      d,
    );

    expect(res).toEqual({ ok: true, threadId: "thread-existing", reused: true });
    expect(calls.created).toEqual([]);
    expect(calls.started).toEqual([]);
    expect(calls.sent).toEqual([]);
  });

  test("reattaches to an existing thread whose session was reaped (no duplicate thread)", async () => {
    const { deps: d, calls } = deps({
      findThreadByName: async () => ({ id: "thread-existing" }),
      hasSession: () => false,
    });

    const res = await openBriefWindow(
      { date: DATE, hasBriefConfig: true, sessionCount: 1, maxSessions: 10 },
      d,
    );

    expect(res).toEqual({ ok: true, threadId: "thread-existing", reused: false });
    expect(calls.created).toEqual([]);
    expect(calls.started).toEqual([
      { threadId: "thread-existing", branch: `corp-brief-window-${DATE}` },
    ]);
  });

  test("AC-4: a capacity refusal is reported to the channel, not swallowed", async () => {
    const { deps: d, calls } = deps();
    const res = await openBriefWindow(
      { date: DATE, hasBriefConfig: true, sessionCount: 10, maxSessions: 10 },
      d,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("skipped");
    expect(res.reason).toBe("capacity");
    expect(calls.channel.length).toBe(1);
    expect(calls.channel[0]).toContain("窓口");
    expect(calls.created).toEqual([]);
  });

  test("a disabled kill-switch is silent (an intentional off-switch is not a failure)", async () => {
    const { deps: d, calls } = deps();
    const res = await openBriefWindow(
      {
        date: DATE,
        hasBriefConfig: true,
        sessionCount: 1,
        maxSessions: 10,
        env: { CORP_BRIEF_WINDOW_DISABLED: "1" },
      },
      d,
    );

    expect(res).toEqual({ ok: false, stage: "skipped", reason: "disabled" });
    expect(calls.channel).toEqual([]);
    expect(calls.failures).toEqual([]);
  });

  test("a start failure is reported to the channel and paged, never silent", async () => {
    const { deps: d, calls } = deps({
      start: async () => {
        throw new Error("最大セッション数 (10) に達しています");
      },
    });

    const res = await openBriefWindow(
      { date: DATE, hasBriefConfig: true, sessionCount: 1, maxSessions: 10 },
      d,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("start");
    expect(calls.channel.length).toBe(1);
    expect(calls.failures.length).toBe(1);
    expect(calls.sent).toEqual([]);
  });

  test("injects anyway when the input-ready marker is missed (RW-025 / RW-047 timing class)", async () => {
    const { deps: d, calls } = deps({ waitForInputReady: async () => false });
    const res = await openBriefWindow(
      { date: DATE, hasBriefConfig: true, sessionCount: 1, maxSessions: 10 },
      d,
    );

    expect(res.ok).toBe(true);
    expect(calls.sent).toEqual([
      { threadId: "thread-new", text: `/brief-window ${DATE}` },
    ]);
  });

  test("an inject failure is reported, and the thread says the window is not usable", async () => {
    const { deps: d, calls } = deps({
      sendMessage: async () => {
        throw new Error("relay refused");
      },
    });

    const res = await openBriefWindow(
      { date: DATE, hasBriefConfig: true, sessionCount: 1, maxSessions: 10 },
      d,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("inject");
    expect(calls.thread.length + calls.channel.length).toBeGreaterThan(0);
    expect(calls.failures.length).toBe(1);
  });
});

describe("createBriefWindowDeps (adapter binding)", () => {
  function fakeChannel() {
    const state = {
      created: [] as Array<{ name: string; autoArchiveDuration: number }>,
      sent: [] as string[],
      active: [] as Array<{ id: string; name: string }>,
    };
    const channel = {
      threads: {
        fetchActive: async () => ({
          threads: {
            find: (p: (t: { name: string; id: string }) => boolean) =>
              state.active.find(p),
          },
        }),
        create: async (o: { name: string; autoArchiveDuration: number }) => {
          state.created.push(o);
          return { id: "created-1" };
        },
      },
      send: async (c: string) => {
        state.sent.push(c);
        return {};
      },
    };
    return { channel, state };
  }

  function build(over: { activeThreads?: Array<{ id: string; name: string }> } = {}) {
    const { channel, state } = fakeChannel();
    state.active = over.activeThreads ?? [];
    const sessions = {
      has: (id: string) => id === "live",
      started: [] as Array<{ threadId: string; branch: string }>,
      sent: [] as Array<{ threadId: string; text: string }>,
      start: async function (threadId: string, branch: string) {
        this.started.push({ threadId, branch });
      },
      waitForInputReady: async () => true,
      sendMessage: async function (threadId: string, text: string) {
        this.sent.push({ threadId, text });
        return { chunks: [STANDBY] };
      },
    };
    const threadSends: Array<{ threadId: string; content: string }> = [];
    const pages: Array<{ title: string; body: string }> = [];
    const deps = createBriefWindowDeps({
      channel,
      sessions,
      fetchThread: async (threadId) =>
        threadId === "missing"
          ? null
          : {
              send: async (content: string) => {
                threadSends.push({ threadId, content });
                return {};
              },
            },
      notifyFailure: async (title, body) => {
        pages.push({ title, body });
      },
    });
    return { deps, state, sessions, threadSends, pages };
  }

  test("findThreadByName matches the window thread by exact name", async () => {
    const { deps } = build({
      activeThreads: [
        { id: "other", name: "corp-dispatch-12" },
        { id: "win", name: `朝レポ窓口 ${DATE}` },
      ],
    });
    expect(await deps.findThreadByName(`朝レポ窓口 ${DATE}`)).toEqual({ id: "win" });
    expect(await deps.findThreadByName("朝レポ窓口 2026-01-01")).toBeNull();
  });

  test("createThread uses the dispatch-equivalent auto-archive window", async () => {
    const { deps, state } = build();
    expect(await deps.createThread("t")).toEqual({ id: "created-1" });
    expect(state.created).toEqual([{ name: "t", autoArchiveDuration: 10080 }]);
  });

  test("postToThread is a no-op when the thread can no longer be fetched", async () => {
    const { deps, threadSends } = build();
    await deps.postToThread("missing", "hi");
    expect(threadSends).toEqual([]);
    await deps.postToThread("t1", "hi");
    expect(threadSends).toEqual([{ threadId: "t1", content: "hi" }]);
  });

  test("postToChannel and hasSession delegate to the bound objects", async () => {
    const { deps, state } = build();
    await deps.postToChannel("notice");
    expect(state.sent).toEqual(["notice"]);
    expect(deps.hasSession("live")).toBe(true);
    expect(deps.hasSession("dead")).toBe(false);
  });
});

describe("openBriefWindowForBrief (eager entry)", () => {
  test("returns the window result on the happy path", async () => {
    const { deps: d, calls } = deps();
    const res = await openBriefWindowForBrief({
      date: DATE,
      channelName: "corp",
      sessionCount: 1,
      maxSessions: 10,
      deps: d,
    });
    expect(res).toEqual({ ok: true, threadId: "thread-new", reused: false });
    expect(calls.created).toEqual([`朝レポ窓口 ${DATE}`]);
  });

  test("never throws into the decision path — an unexpected error becomes a result", async () => {
    const { deps: d } = deps({
      findThreadByName: async () => {
        throw new Error("discord exploded");
      },
      postToChannel: async () => {
        throw new Error("channel gone too");
      },
      notifyFailure: async () => {
        throw new Error("pushover down");
      },
    });
    const res = await openBriefWindowForBrief({
      date: DATE,
      channelName: "corp",
      sessionCount: 1,
      maxSessions: 10,
      deps: d,
    });
    expect(res.ok).toBe(false);
  });
});

describe("standby report delivery (#464)", () => {
  const open = (d: BriefWindowDeps) =>
    openBriefWindow(
      { date: DATE, hasBriefConfig: true, sessionCount: 1, maxSessions: 10 },
      d,
    );

  test("posts the CEO standby report into the window thread", async () => {
    // 本番初回 (2026-08-27) の回帰: ペインには報告が出ているのにスレッドは空だった。
    const { deps: d, calls } = deps();
    const res = await open(d);

    expect(res.ok).toBe(true);
    expect(calls.thread).toEqual([{ threadId: "thread-new", content: STANDBY }]);
  });

  test("posts every non-empty chunk and drops blank ones", async () => {
    const { deps: d, calls } = deps({
      sendMessage: async () => ({ chunks: ["one", "   ", "two"] }),
    });
    await open(d);

    expect(calls.thread.map((c) => c.content)).toEqual(["one", "two"]);
  });

  test("says so instead of going quiet when no chunk comes back", async () => {
    const { deps: d, calls } = deps({
      sendMessage: async () => ({ chunks: [] }),
    });
    const res = await open(d);

    expect(res.ok).toBe(true);
    expect(calls.thread.map((c) => c.content)).toEqual([
      BRIEF_WINDOW_EMPTY_REPLY_NOTICE,
    ]);
  });

  test("surfaces a relay error in the thread", async () => {
    const { deps: d, calls } = deps({
      sendMessage: async () => ({ chunks: [], error: "relay timeout" }),
    });
    const res = await open(d);

    expect(res.ok).toBe(true);
    expect(calls.thread.length).toBe(1);
    expect(calls.thread[0]!.content).toContain(BRIEF_WINDOW_REPLY_ERROR_NOTICE);
    expect(calls.thread[0]!.content).toContain("relay timeout");
  });

  test("a failed post does not undo the window itself", async () => {
    // 窓口は既に使える。挨拶が出ないことと窓口が無いことは別物。
    const { deps: d } = deps({
      postToThread: async () => {
        throw new Error("discord 500");
      },
    });
    const res = await open(d);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.threadId).toBe("thread-new");
  });

  test("an inject failure reports the failure and never a standby report", async () => {
    const { deps: d, calls } = deps({
      sendMessage: async () => {
        throw new Error("pane gone");
      },
    });
    const res = await open(d);

    expect(res.ok).toBe(false);
    expect(calls.thread.length).toBe(1);
    expect(calls.thread[0]!.content).toContain("pane gone");
    expect(calls.failures.length).toBe(1);
  });
});

describe("handleBriefWindowThreadMessage (lazy entry)", () => {
  const base = {
    threadId: "win-1",
    threadName: `朝レポ窓口 ${DATE}`,
    hasBriefConfig: true,
    sessionCount: 2,
    maxSessions: 10,
  };

  test("AC-5: restarts the window and tells the chairman to resend", async () => {
    const { deps: d, calls } = deps();
    const consumed = await handleBriefWindowThreadMessage({ ...base, deps: d });

    expect(consumed).toBe("restarted");
    expect(calls.started).toEqual([
      { threadId: "win-1", branch: `corp-brief-window-${DATE}` },
    ]);
    expect(calls.sent).toEqual([
      { threadId: "win-1", text: `/brief-window ${DATE}` },
    ]);
    // 待機報告 → 再送依頼の順で出る（#464 で前者が加わった）。
    expect(calls.thread.map((c) => c.content)).toEqual([
      STANDBY,
      BRIEF_WINDOW_RESTART_NOTICE,
    ]);
  });

  test("hands non-window threads back to the existing salvage path", async () => {
    const { deps: d, calls } = deps();
    const consumed = await handleBriefWindowThreadMessage({
      ...base,
      threadName: "corp-dispatch-12 Corp CEO 1",
      deps: d,
    });
    expect(consumed).toBe("not_window");
    expect(calls.started).toEqual([]);
  });

  test("#463: keeps a disabled window away from the generic wake and says why", async () => {
    const { deps: d, calls } = deps();
    const consumed = await handleBriefWindowThreadMessage({
      ...base,
      deps: d,
      env: { CORP_BRIEF_WINDOW_DISABLED: "1" },
    });
    // "not_window" ではないので bot.ts は汎用 auto-resume に落とさない。
    expect(consumed).toBe("blocked");
    expect(calls.started).toEqual([]);
    expect(calls.thread.map((c) => c.content)).toEqual([
      BRIEF_WINDOW_DISABLED_NOTICE,
    ]);
  });

  test("#463: same for a window thread whose channel has no brief config", async () => {
    const { deps: d, calls } = deps();
    const consumed = await handleBriefWindowThreadMessage({
      ...base,
      hasBriefConfig: false,
      deps: d,
    });
    expect(consumed).toBe("blocked");
    expect(calls.started).toEqual([]);
    expect(calls.thread.map((c) => c.content)).toEqual([
      BRIEF_WINDOW_NO_CONFIG_NOTICE,
    ]);
  });

  test("consumes the message at the session cap (the reason was posted in-thread)", async () => {
    const { deps: d, calls } = deps();
    const consumed = await handleBriefWindowThreadMessage({
      ...base,
      sessionCount: 10,
      deps: d,
    });
    expect(consumed).toBe("blocked");
    expect(calls.thread.length).toBe(1);
    expect(calls.started).toEqual([]);
  });

  test("consumes the message when the restart itself fails (already reported)", async () => {
    const { deps: d, calls } = deps({
      start: async () => {
        throw new Error("tmux refused");
      },
    });
    const consumed = await handleBriefWindowThreadMessage({ ...base, deps: d });
    expect(consumed).toBe("blocked");
    expect(calls.failures.length).toBe(1);
  });
});
