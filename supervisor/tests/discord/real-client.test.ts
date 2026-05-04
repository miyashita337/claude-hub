// Light unit tests for RealDiscordClient (Issue #144 Phase 1).
//
// These tests verify construction and lifecycle gating without actually
// reaching Discord — the discord.js Client is constructed but never logged in.
// Behavioral E2E coverage lives in Phase 2's lifecycle test, which routes
// through InMemoryDiscordClient and the real tmux + claude-mock.sh.

import { afterEach, describe, expect, test } from "bun:test";
import { Client, GatewayIntentBits } from "discord.js";
import { RealDiscordClient } from "../../src/discord/real-client";

describe("RealDiscordClient", () => {
  const created: RealDiscordClient[] = [];

  afterEach(async () => {
    while (created.length) {
      const c = created.pop()!;
      try {
        await c.stop();
      } catch {
        // best-effort cleanup
      }
    }
  });

  test("constructor rejects empty token", () => {
    expect(() => new RealDiscordClient("")).toThrow(/token is required/);
  });

  test("constructor accepts injected Client", () => {
    const inner = new Client({
      intents: [GatewayIntentBits.Guilds],
    });
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);
    expect(wrapper.getUnderlyingClient()).toBe(inner);
  });

  test("sendToThread before start throws", async () => {
    const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);
    await expect(wrapper.sendToThread("t1", "hi")).rejects.toThrow(/not started/);
  });

  test("sendTyping before start throws", async () => {
    const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);
    await expect(wrapper.sendTyping("t1")).rejects.toThrow(/not started/);
  });

  test("onThreadMessage / onSlashCommand register without throwing", () => {
    const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);
    expect(() => wrapper.onThreadMessage(() => {})).not.toThrow();
    expect(() => wrapper.onSlashCommand(() => {})).not.toThrow();
  });

  test("stop is idempotent", async () => {
    const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);
    await wrapper.stop();
    await wrapper.stop(); // second call should be a no-op
  });

  test("start after stop throws", async () => {
    const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);
    await wrapper.stop();
    await expect(wrapper.start()).rejects.toThrow(/cannot start after stop/);
  });

  test("injecting MessageCreate via underlying Client emits to handlers", () => {
    // Use the underlying EventEmitter directly to avoid logging in. The
    // wrapper subscribes to Events.MessageCreate at construction time, so
    // emitting that event fires the chain. We feed a minimal message-shaped
    // object to assert the propagation contract end-to-end (gating + payload).
    const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);

    const events: Array<{ threadId: string; content: string; isBot: boolean }> = [];
    wrapper.onThreadMessage((m) => {
      events.push({ threadId: m.threadId, content: m.content, isBot: m.authorBot });
    });

    const baseMessage = {
      author: { bot: false, id: "user_1" },
      channel: { isThread: () => true, id: "thread_1" },
      content: "hi from user",
      id: "msg_1",
      attachments: new Map(),
    };

    inner.emit("messageCreate", baseMessage as never);
    expect(events).toEqual([
      { threadId: "thread_1", content: "hi from user", isBot: false },
    ]);

    // Bot author → gated out
    inner.emit("messageCreate", {
      ...baseMessage,
      author: { bot: true, id: "bot_2" },
      id: "msg_2",
      content: "bot says",
    } as never);

    // Non-thread channel → gated out
    inner.emit("messageCreate", {
      ...baseMessage,
      id: "msg_3",
      channel: { isThread: () => false, id: "channel_1" },
      content: "channel msg",
    } as never);

    expect(events).toHaveLength(1);
  });
});
