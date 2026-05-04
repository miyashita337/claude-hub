// Unit tests for InMemoryDiscordClient (Issue #144 Phase 1).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryDiscordClient } from "../../src/discord/in-memory-client";
import type {
  DiscordSlashCommand,
  DiscordThreadMessage,
} from "../../src/discord/types";

describe("InMemoryDiscordClient", () => {
  let client: InMemoryDiscordClient;

  beforeEach(async () => {
    client = new InMemoryDiscordClient();
    await client.start();
  });

  afterEach(async () => {
    if (client.isStarted()) await client.stop();
  });

  test("isStarted reflects start/stop lifecycle", async () => {
    expect(client.isStarted()).toBe(true);
    await client.stop();
    expect(client.isStarted()).toBe(false);
  });

  test("start after stop throws", async () => {
    await client.stop();
    await expect(client.start()).rejects.toThrow(/cannot start after stop/);
  });

  test("sendToThread before start throws", async () => {
    const fresh = new InMemoryDiscordClient();
    await expect(fresh.sendToThread("t1", "hi")).rejects.toThrow(/not started/);
  });

  test("sendToThread after stop throws", async () => {
    await client.stop();
    await expect(client.sendToThread("t1", "hi")).rejects.toThrow(
      /already stopped/,
    );
  });

  test("sendToThread records messages with options", async () => {
    await client.sendToThread("t1", "hello");
    await client.sendToThread("t1", "world", {
      files: [{ name: "out.txt", attachment: "/tmp/out.txt" }],
    });
    await client.sendToThread("t2", "other");

    const t1 = client.getSentMessages("t1");
    expect(t1).toHaveLength(2);
    expect(t1[0]!.content).toBe("hello");
    expect(t1[0]!.options.files).toBeUndefined();
    expect(t1[1]!.content).toBe("world");
    expect(t1[1]!.options.files?.[0]?.name).toBe("out.txt");

    expect(client.getSentMessages("t2")).toHaveLength(1);
    expect(client.getSentMessages()).toHaveLength(3);
  });

  test("sendTyping increments per-thread counter", async () => {
    await client.sendTyping("t1");
    await client.sendTyping("t1");
    await client.sendTyping("t2");
    expect(client.getTypingCallCount("t1")).toBe(2);
    expect(client.getTypingCallCount("t2")).toBe(1);
    expect(client.getTypingCallCount("missing")).toBe(0);
  });

  test("injectThreadMessage fires registered handlers in order", () => {
    const events: DiscordThreadMessage[] = [];
    client.onThreadMessage((m) => events.push({ ...m, content: `H1:${m.content}` }));
    client.onThreadMessage((m) => events.push({ ...m, content: `H2:${m.content}` }));

    client.injectThreadMessage({ threadId: "t1", content: "ping" });

    expect(events).toHaveLength(2);
    expect(events[0]!.content).toBe("H1:ping");
    expect(events[1]!.content).toBe("H2:ping");
    expect(events[0]!.threadId).toBe("t1");
    expect(events[0]!.authorBot).toBe(false);
  });

  test("injectThreadMessage gates bot messages (mirrors RealDiscordClient)", () => {
    const events: DiscordThreadMessage[] = [];
    client.onThreadMessage((m) => events.push(m));
    client.injectThreadMessage({
      threadId: "t1",
      content: "bot says hi",
      authorBot: true,
    });
    expect(events).toHaveLength(0);
  });

  test("injectThreadMessage auto-generates messageId when omitted", () => {
    const events: DiscordThreadMessage[] = [];
    client.onThreadMessage((m) => events.push(m));
    client.injectThreadMessage({ threadId: "t1", content: "a" });
    client.injectThreadMessage({ threadId: "t1", content: "b" });
    expect(events[0]!.messageId).toMatch(/^msg_/);
    expect(events[1]!.messageId).toMatch(/^msg_/);
    expect(events[0]!.messageId).not.toBe(events[1]!.messageId);
  });

  test("injectThreadMessage propagates explicit attachments", () => {
    const events: DiscordThreadMessage[] = [];
    client.onThreadMessage((m) => events.push(m));
    client.injectThreadMessage({
      threadId: "t1",
      content: "see file",
      attachments: [
        { url: "https://x/y.png", filename: "y.png", contentType: "image/png" },
      ],
    });
    expect(events[0]!.attachments).toHaveLength(1);
    expect(events[0]!.attachments[0]!.filename).toBe("y.png");
  });

  test("injectSlashCommand fires handlers and reply records into log", async () => {
    const seen: DiscordSlashCommand[] = [];
    client.onSlashCommand((c) => seen.push(c));

    client.injectSlashCommand({
      commandName: "session",
      options: { action: "start" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.action).toBe("start");

    await seen[0]!.reply("started", true);
    const replies = client.getSlashReplies();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toBe("started");
    expect(replies[0]!.ephemeral).toBe(true);
    expect(replies[0]!.commandName).toBe("session");
  });

  test("onReply callback receives reply args before they are recorded", async () => {
    const captured: Array<{ content: string; ephemeral: boolean }> = [];

    // Plain reply (no callback): records into slashReplies log only.
    const cmds: DiscordSlashCommand[] = [];
    client.onSlashCommand((c) => cmds.push(c));
    client.injectSlashCommand({ commandName: "session" });
    await cmds[0]!.reply("ack");
    expect(client.getSlashReplies().some((r) => r.content === "ack")).toBe(true);

    // With onReply callback: callback fires alongside slashReplies log.
    client.injectSlashCommand({
      commandName: "session",
      onReply: (content, ephemeral) => {
        captured.push({ content, ephemeral });
      },
    });
    await cmds[1]!.reply("with-callback", true);
    expect(captured).toEqual([{ content: "with-callback", ephemeral: true }]);
  });

  test("clearLogs resets sent/typing/slashReplies but keeps handlers", async () => {
    const handlerCalls: string[] = [];
    client.onThreadMessage((m) => handlerCalls.push(m.content));
    await client.sendToThread("t1", "before");
    await client.sendTyping("t1");
    client.injectSlashCommand({ commandName: "session" });

    client.clearLogs();
    expect(client.getSentMessages()).toHaveLength(0);
    expect(client.getTypingCallCount("t1")).toBe(0);
    expect(client.getSlashReplies()).toHaveLength(0);

    // Handler still wired
    client.injectThreadMessage({ threadId: "t1", content: "after" });
    expect(handlerCalls).toEqual(["after"]);
  });

  test("handler exception in injectThreadMessage is isolated and recorded", () => {
    // Mirror RealDiscordClient: one throwing handler must not abort the chain.
    // Errors are captured in getHandlerErrors() so tests can still assert.
    const seen: string[] = [];
    client.onThreadMessage(() => {
      throw new Error("boom-1");
    });
    client.onThreadMessage((m) => {
      seen.push(m.content);
    });
    client.injectThreadMessage({ threadId: "t1", content: "still-delivered" });
    expect(seen).toEqual(["still-delivered"]);
    const errors = client.getHandlerErrors();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom-1");
  });

  test("handler exception in injectSlashCommand is isolated and recorded", () => {
    const seen: string[] = [];
    client.onSlashCommand(() => {
      throw new Error("slash-boom");
    });
    client.onSlashCommand((c) => {
      seen.push(c.commandName);
    });
    client.injectSlashCommand({ commandName: "session" });
    expect(seen).toEqual(["session"]);
    expect(client.getHandlerErrors()).toHaveLength(1);
  });

  test("clearLogs resets handlerErrors", () => {
    client.onThreadMessage(() => {
      throw new Error("x");
    });
    client.injectThreadMessage({ threadId: "t1", content: "x" });
    expect(client.getHandlerErrors()).toHaveLength(1);
    client.clearLogs();
    expect(client.getHandlerErrors()).toHaveLength(0);
  });

  test("injectSlashCommand after stop throws", async () => {
    await client.stop();
    expect(() =>
      client.injectSlashCommand({ commandName: "session" }),
    ).toThrow(/already stopped/);
  });

  test("injectThreadMessage after stop throws", async () => {
    await client.stop();
    expect(() =>
      client.injectThreadMessage({ threadId: "t1", content: "x" }),
    ).toThrow(/already stopped/);
  });
});
