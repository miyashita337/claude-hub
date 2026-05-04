// Unit tests for wireBotHandlers (Issue #144 Phase 2).
//
// SessionManager is faked at the call-site level so these tests don't spawn
// tmux. The lifecycle E2E (tests/e2e/discord-lifecycle.test.ts) runs the
// same handler against a real SessionManager + tmux + claude-mock.sh.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryDiscordClient } from "../../src/discord/in-memory-client";
import { wireBotHandlers } from "../../src/discord/handler";
import type { ChannelConfig } from "../../src/config/channels";
import type { SessionManager } from "../../src/session/manager";
import type { RelayResult } from "../../src/session/relay-server";

// Pick the SessionManager surface handler.ts depends on. Using `Pick`
// instead of a hand-rolled interface gives us a compile-time alarm if
// production renames `start` / `stop` / `sendMessage` / `has`.
type FakeSessionManager = Pick<
  SessionManager,
  "start" | "stop" | "sendMessage" | "has"
>;

function makeChannelConfig(name: string): ChannelConfig {
  return {
    channelName: name,
    dir: `/tmp/${name}`,
    displayName: `display-${name}`,
  } as ChannelConfig;
}

interface SuiteContext {
  client: InMemoryDiscordClient;
  sessionManagerEvents: string[];
  fakeSm: FakeSessionManager;
  hasMap: Map<string, boolean>;
  relayResults: Map<string, RelayResult>;
}

let ctx: SuiteContext;

beforeEach(async () => {
  const client = new InMemoryDiscordClient();
  await client.start();
  const events: string[] = [];
  const hasMap = new Map<string, boolean>();
  const relayResults = new Map<string, RelayResult>();
  // Fields beyond the public surface fan out to a wide SessionInfo struct;
  // the test cast keeps the spotlight on the four methods Pick selects
  // while still alarming if any of those four are renamed.
  const fakeSm: FakeSessionManager = {
    start: ((config, threadId) => {
      events.push(`start:${config.channelName}:${threadId}`);
      hasMap.set(threadId, true);
      return { id: "sess-test", threadId } as unknown;
    }) as SessionManager["start"],
    stop: (async (threadId, reason) => {
      events.push(`stop:${threadId}:${reason}`);
      hasMap.delete(threadId);
    }) as SessionManager["stop"],
    sendMessage: (async (threadId, content) => {
      events.push(`send:${threadId}:${content}`);
      const r = relayResults.get(threadId);
      if (r) return r;
      return { text: `echo:${content}`, chunks: [`echo:${content}`] };
    }) as SessionManager["sendMessage"],
    has: (threadId) => hasMap.has(threadId),
  };
  wireBotHandlers(
    client,
    fakeSm as unknown as Parameters<typeof wireBotHandlers>[1],
    {
      resolveChannel: (n) => (n === "team-salary" ? makeChannelConfig(n) : undefined),
      threadIdFor: (cmd) =>
        String(cmd.options.threadId ?? cmd.channelId ?? "thread-default"),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
  );
  ctx = { client, sessionManagerEvents: events, fakeSm, hasMap, relayResults };
});

afterEach(async () => {
  if (ctx.client.isStarted()) await ctx.client.stop();
});

describe("wireBotHandlers — slash commands", () => {
  test("/session start with known channel calls SessionManager.start and replies", async () => {
    ctx.client.injectSlashCommand({
      commandName: "session",
      subcommand: "start",
      options: { channel: "team-salary", threadId: "t1" },
    });
    await waitForEvents(ctx.sessionManagerEvents, 1);
    expect(ctx.sessionManagerEvents).toEqual(["start:team-salary:t1"]);
    expect(ctx.hasMap.get("t1")).toBe(true);
    const replies = await waitForReplies(ctx.client, 1);
    expect(replies[0]!.content).toContain("display-team-salary");
    expect(replies[0]!.content).toContain("t1");
  });

  test("/session start with unknown channel replies error and does not call start", async () => {
    ctx.client.injectSlashCommand({
      commandName: "session",
      subcommand: "start",
      options: { channel: "no-such-channel", threadId: "t1" },
    });
    const replies = await waitForReplies(ctx.client, 1);
    expect(replies[0]!.content).toContain("未知のチャンネル");
    expect(replies[0]!.ephemeral).toBe(true);
    expect(ctx.sessionManagerEvents).toEqual([]);
  });

  test("/session stop drives SessionManager.stop and replies", async () => {
    ctx.hasMap.set("t1", true);
    ctx.client.injectSlashCommand({
      commandName: "session",
      subcommand: "stop",
      options: { threadId: "t1" },
    });
    await waitForEvents(ctx.sessionManagerEvents, 1);
    expect(ctx.sessionManagerEvents).toEqual(["stop:t1:manual"]);
    expect(ctx.hasMap.has("t1")).toBe(false);
    const replies = await waitForReplies(ctx.client, 1);
    expect(replies[0]!.content).toContain("停止しました");
  });

  test("unknown subcommand replies a hint", async () => {
    ctx.client.injectSlashCommand({
      commandName: "session",
      subcommand: "wat",
      options: {},
    });
    const replies = await waitForReplies(ctx.client, 1);
    expect(replies[0]!.content).toContain("未知のサブコマンド");
  });

});

describe("wireBotHandlers — thread messages", () => {
  test("thread message routes through sendMessage and emits chunks back", async () => {
    ctx.hasMap.set("t1", true);
    ctx.relayResults.set("t1", {
      text: "hello back",
      chunks: ["chunk-a", "chunk-b"],
    });
    ctx.client.injectThreadMessage({ threadId: "t1", content: "ping" });
    await waitForEvents(ctx.sessionManagerEvents, 1);
    expect(ctx.sessionManagerEvents).toEqual(["send:t1:ping"]);
    // Sent messages: chunk-a, chunk-b. Plus typing call.
    const sent = await waitForSentMessages(ctx.client, "t1", 2);
    expect(sent.map((s) => s.content)).toEqual(["chunk-a", "chunk-b"]);
    expect(ctx.client.getTypingCallCount("t1")).toBe(1);
  });

  test("thread message without active session is skipped", async () => {
    ctx.client.injectThreadMessage({ threadId: "t-unknown", content: "ping" });
    // Give the async dispatch a tick to settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.sessionManagerEvents).toEqual([]);
    expect(ctx.client.getSentMessages("t-unknown")).toEqual([]);
  });

  test("bot author flag is gated by InMemoryDiscordClient before reaching handler", async () => {
    ctx.hasMap.set("t1", true);
    // InMemoryDiscordClient mirrors RealDiscordClient: bot-authored messages
    // are dropped before handlers fire.
    ctx.client.injectThreadMessage({
      threadId: "t1",
      content: "from-bot",
      authorBot: true,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.sessionManagerEvents).toEqual([]);
  });

  test("empty chunks (whitespace) are not posted back", async () => {
    ctx.hasMap.set("t1", true);
    ctx.relayResults.set("t1", {
      text: "",
      chunks: ["   ", "real", "\n"],
    });
    ctx.client.injectThreadMessage({ threadId: "t1", content: "ping" });
    await waitForEvents(ctx.sessionManagerEvents, 1);
    const sent = await waitForSentMessages(ctx.client, "t1", 1);
    expect(sent.map((s) => s.content)).toEqual(["real"]);
  });
});

// ---- helpers ----

async function waitForEvents(events: string[], min: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (events.length >= min) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waited 500ms but only got ${events.length} events`);
}

async function waitForSentMessages(
  client: InMemoryDiscordClient,
  threadId: string,
  min: number,
) {
  for (let i = 0; i < 50; i++) {
    const sent = client.getSentMessages(threadId);
    if (sent.length >= min) return sent;
    await new Promise((r) => setTimeout(r, 10));
  }
  return client.getSentMessages(threadId);
}

async function waitForReplies(client: InMemoryDiscordClient, min: number) {
  for (let i = 0; i < 50; i++) {
    const replies = client.getSlashReplies();
    if (replies.length >= min) return replies;
    await new Promise((r) => setTimeout(r, 10));
  }
  return client.getSlashReplies();
}
