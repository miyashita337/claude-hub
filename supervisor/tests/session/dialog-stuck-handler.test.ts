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
});
