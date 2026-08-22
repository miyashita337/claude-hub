// Issue #447: parent-channel "決裁待ち" notice — the resolution/guard branches.
//
// Review on #447 (should-1): buildAskChannelNotice / postAskChannelNotice are
// unit-tested in ask-components.test.ts, and the wiring test there pins that
// bot.ts calls notifyAskParentChannel — but nothing drove the function itself:
// the parent-cache-miss fetch fallback (PR #340's failure class), the
// text-parent guard (a forum parent has no `.send()`), and the best-effort
// catch were all unreachable in CI. These fakes drive exactly those branches.
import { test, expect, describe } from "bun:test";
import {
  notifyAskParentChannel,
  type AskNoticeClient,
  type AskNoticeParentCandidate,
  type AskNoticeThreadRef,
} from "../../src/bot";

interface SentMessage {
  content: string;
  components?: unknown[];
}

function makeParent(opts?: {
  textBased?: boolean;
  dmBased?: boolean;
  sendThrows?: boolean;
  /** Omit `.send` entirely (forum/media channels are typed without one). */
  noSend?: boolean;
}) {
  const sent: SentMessage[] = [];
  const parent: AskNoticeParentCandidate = {
    isTextBased: () => opts?.textBased ?? true,
    isDMBased: () => opts?.dmBased ?? false,
    ...(opts?.noSend
      ? {}
      : {
          send: async (options: SentMessage) => {
            if (opts?.sendThrows) throw new Error("send boom");
            sent.push(options);
            return { id: "notice-1" };
          },
        }),
  };
  return { parent, sent };
}

function makeClient(result: AskNoticeParentCandidate | null | Error) {
  const fetched: string[] = [];
  const client: AskNoticeClient = {
    channels: {
      fetch: async (id: string) => {
        fetched.push(id);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return { client, fetched };
}

function makeThread(
  parent: AskNoticeParentCandidate | null,
  parentId: string | null = "parent-1",
): AskNoticeThreadRef {
  return { id: "thread-1", parent, parentId };
}

describe("notifyAskParentChannel (#447)", () => {
  test("cached parent: posts one notice, never fetches", async () => {
    const { parent, sent } = makeParent();
    const { client, fetched } = makeClient(null);

    await notifyAskParentChannel(client, makeThread(parent), 2);

    expect(fetched).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toBe("📥 決裁待ち 2 件 → <#thread-1>");
  });

  test("cache miss: falls back to fetching parentId (PR #340's failure class)", async () => {
    const { parent, sent } = makeParent();
    const { client, fetched } = makeClient(parent);

    await notifyAskParentChannel(client, makeThread(null, "parent-1"), 1);

    expect(fetched).toEqual(["parent-1"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toBe("📥 決裁待ち 1 件 → <#thread-1>");
  });

  test("no parent anywhere (null cache, null parentId): skips without fetching", async () => {
    const { client, fetched } = makeClient(null);

    await notifyAskParentChannel(client, makeThread(null, null), 1);

    expect(fetched).toHaveLength(0);
  });

  test("non-text parent (forum: isTextBased false, no send) is skipped", async () => {
    const { parent } = makeParent({ textBased: false, noSend: true });
    const { client } = makeClient(null);

    // Must return normally — a forum parent has no `.send()`, so reaching the
    // post would throw, and the guard is what prevents that.
    await notifyAskParentChannel(client, makeThread(parent), 1);
  });

  test("DM-based parent is skipped", async () => {
    const { parent, sent } = makeParent({ dmBased: true });
    const { client } = makeClient(null);

    await notifyAskParentChannel(client, makeThread(parent), 1);

    expect(sent).toHaveLength(0);
  });

  test("fetch failure is swallowed (best-effort: never rethrows into the ask path)", async () => {
    const { client } = makeClient(new Error("Unknown Channel"));

    // Journey AC-3 isolation: the question is already posted and answerable;
    // a notice failure must never surface as an ask failure.
    await notifyAskParentChannel(client, makeThread(null, "parent-1"), 1);
  });

  test("send failure is swallowed (best-effort)", async () => {
    const { parent, sent } = makeParent({ sendThrows: true });
    const { client } = makeClient(null);

    await notifyAskParentChannel(client, makeThread(parent), 3);

    expect(sent).toHaveLength(0);
  });
});
