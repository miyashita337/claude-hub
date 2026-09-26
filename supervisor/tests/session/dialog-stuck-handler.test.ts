import { test, expect, describe, mock } from "bun:test";
import {
  buildDialogStuckHandler,
  createPageOnce,
  type DialogStuckInfo,
} from "../../src/session/dialog-stuck-handler";

function makeThread() {
  const sent: string[] = [];
  return {
    sent,
    send: async (content: string) => {
      sent.push(content);
    },
  };
}

describe("buildDialogStuckHandler", () => {
  test("posts a heartbeat with tmux session name + kind for known dialogs", async () => {
    const thread = makeThread();
    const pushover = mock(async () => true);
    const handler = buildDialogStuckHandler(thread, { pushover });

    const info: DialogStuckInfo = {
      kind: "ink-confirm",
      line: "Do you want to proceed?",
      tmuxSessionName: "claude-abc123",
    };
    await handler(info);

    expect(thread.sent).toHaveLength(1);
    const msg = thread.sent[0]!;
    expect(msg).toContain("claude-abc123");
    expect(msg).toContain("tmux -L claude-hub attach -t claude-abc123");
    expect(msg).toContain("ink-confirm");
    expect(pushover).toHaveBeenCalledTimes(1);
  });

  // Issue #423: an AskUserQuestion that reached the TUI is a question that
  // never got to Discord — not a stuck dialog. The notice has to say so, and
  // has to say nothing was auto-selected: the incident's first question from
  // the 会長 was whether he had answered.
  test("says the question was not delivered and nothing was auto-selected (Issue #423)", async () => {
    const thread = makeThread();
    const pushover = mock(async () => true);
    const handler = buildDialogStuckHandler(thread, { pushover });

    await handler({
      kind: "ask-user-question",
      line: "3. Type something.",
      tmuxSessionName: "claude-abc123",
    });

    const msg = thread.sent[0]!;
    expect(msg).toContain("質問");
    expect(msg).toContain("自動では選ばれません");
    // Still tells the user how to reach the session.
    expect(msg).toContain("tmux -L claude-hub attach -t claude-abc123");
    // Must NOT reuse the generic "手動操作要求" framing — that wording is what
    // made an invented answer indistinguishable from a real one.
    expect(msg).not.toContain("手動操作要求");
    expect(pushover).toHaveBeenCalledTimes(1);
  });

  // Issue #452 / corp#105: a usage-limit dialog is not a stuck confirmation —
  // there is no key that clears it. The notice must say what actually
  // happened (upstream quota exhausted) and how to recover (`/model` or wait
  // for reset), not the generic "手動操作要求" framing used for dialogs a key
  // press *can* resolve.
  test("says the model usage limit was reached and how to recover (Issue #452)", async () => {
    const thread = makeThread();
    const pushover = mock(async () => true);
    const handler = buildDialogStuckHandler(thread, { pushover });

    await handler({
      kind: "usage-limit",
      line: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
      tmuxSessionName: "claude-abc123",
    });

    const msg = thread.sent[0]!;
    expect(msg).toContain("モデル利用上限");
    expect(msg).toContain("/model");
    expect(msg).toContain("tmux -L claude-hub attach -t claude-abc123");
    expect(msg).toContain("reached your Fable 5 limit");
    expect(pushover).toHaveBeenCalledTimes(1);
  });

  test("uses 'ブロック中' phrasing for stall (unknown dialog)", async () => {
    const thread = makeThread();
    const pushover = mock(async () => true);
    const handler = buildDialogStuckHandler(thread, { pushover });

    await handler({
      kind: "stall",
      line: "",
      tmuxSessionName: "claude-stall1",
    });

    expect(thread.sent[0]!).toContain("応答待ちでブロック中");
    expect(thread.sent[0]!).toContain("claude-stall1");
    expect(pushover).toHaveBeenCalledTimes(1);
  });

  test("still pages Pushover when Discord thread.send throws", async () => {
    const pushover = mock(async () => true);
    const throwingThread = {
      send: async () => {
        throw new Error("discord 500");
      },
    };
    const handler = buildDialogStuckHandler(throwingThread, { pushover });

    // must not throw
    await handler({ kind: "stall", line: "", tmuxSessionName: "claude-x" });
    expect(pushover).toHaveBeenCalledTimes(1);
  });

  test("still posts to Discord when pushover throws", async () => {
    const thread = makeThread();
    const pushover = mock(async () => {
      throw new Error("pushover boom");
    });
    const handler = buildDialogStuckHandler(thread, { pushover });

    await handler({ kind: "bash-yn", line: "(y/n)", tmuxSessionName: "claude-y" });
    expect(thread.sent).toHaveLength(1);
  });
});

describe("createPageOnce", () => {
  const info = (kind: string): DialogStuckInfo => ({
    kind,
    line: "",
    tmuxSessionName: "claude-z",
  });

  test("pages only on the first trigger (watchdog then stall)", async () => {
    const calls: string[] = [];
    const pageOnce = createPageOnce((i) => void calls.push(i.kind));

    await pageOnce(info("ink-confirm")); // watchdog wins
    await pageOnce(info("stall")); // stall suppressed
    await pageOnce(info("stall"));

    expect(calls).toEqual(["ink-confirm"]);
  });

  test("forwards the handler's promise on the first call", async () => {
    let resolved = false;
    const pageOnce = createPageOnce(async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    });
    await pageOnce(info("stall"));
    expect(resolved).toBe(true);
  });

  test("is a safe no-op when no handler is supplied", () => {
    const pageOnce = createPageOnce(undefined);
    expect(pageOnce(info("stall"))).toBeUndefined();
  });

  // Issue #452 (devils-advocate review, M1): a usage-limit hit is often
  // discovered LATE in a turn (Claude was legitimately working, not stuck),
  // so the generic 3-min stall heartbeat (stall-heartbeat.ts) frequently fires
  // FIRST — well before the watchdog's specific "usage-limit" detection. Before
  // this fix, `pageOnce`'s naive "first call wins" rule then silently dropped
  // the specific, actionable page, leaving the user with only the generic
  // "応答待ちでブロック中" message and no mention of the real cause — exactly
  // the corp#105 symptom this Issue exists to fix.
  test("upgrades from a generic stall page to a specific dialog kind (Issue #452)", async () => {
    const calls: string[] = [];
    const pageOnce = createPageOnce((i) => void calls.push(i.kind));

    await pageOnce(info("stall")); // stall fires first (long-running turn)
    await pageOnce(info("usage-limit")); // watchdog catches up — must still page

    expect(calls).toEqual(["stall", "usage-limit"]);
  });

  test("the upgrade happens at most once — a second specific kind after the upgrade is suppressed", async () => {
    const calls: string[] = [];
    const pageOnce = createPageOnce((i) => void calls.push(i.kind));

    await pageOnce(info("stall"));
    await pageOnce(info("usage-limit"));
    await pageOnce(info("ink-confirm")); // already upgraded once — suppressed

    expect(calls).toEqual(["stall", "usage-limit"]);
  });

  test("two stall triggers never both page (no upgrade from stall to stall)", async () => {
    const calls: string[] = [];
    const pageOnce = createPageOnce((i) => void calls.push(i.kind));

    await pageOnce(info("stall"));
    await pageOnce(info("stall"));

    expect(calls).toEqual(["stall"]);
  });

  test("a specific kind first still blocks a later stall (unchanged pre-#452 behaviour)", async () => {
    const calls: string[] = [];
    const pageOnce = createPageOnce((i) => void calls.push(i.kind));

    await pageOnce(info("ink-confirm"));
    await pageOnce(info("stall"));

    expect(calls).toEqual(["ink-confirm"]);
  });
});
