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

  test("start() leaves client un-started when login fails (retryable)", async () => {
    // Stub Client whose login() rejects. Under the fix, started must remain
    // false so the caller can retry. Before the fix, a second start() would
    // short-circuit and never re-attempt login.
    let loginCalls = 0;
    const stub = new Client({ intents: [GatewayIntentBits.Guilds] });
    // Override login to count attempts and reject the first.
    (stub as unknown as { login: (t: string) => Promise<string> }).login =
      async () => {
        loginCalls += 1;
        if (loginCalls === 1) throw new Error("auth-fail");
        return "token-ok";
      };

    const wrapper = new RealDiscordClient("fake-token", { client: stub });
    created.push(wrapper);

    await expect(wrapper.start()).rejects.toThrow(/auth-fail/);
    // Second attempt must reach login() again, not no-op.
    await wrapper.start();
    expect(loginCalls).toBe(2);
  });

  test("InteractionCreate flattens subcommand options and exposes subcommand name", async () => {
    const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);

    const seen: Array<{
      commandName: string;
      subcommand?: string;
      options: Record<string, string | number | boolean>;
    }> = [];
    wrapper.onSlashCommand((c) => {
      seen.push({
        commandName: c.commandName,
        subcommand: c.subcommand,
        options: c.options,
      });
    });

    // Synthesize a /session start subcommand interaction. type=1 is
    // ApplicationCommandOptionType.Subcommand. Top-level data has a single
    // entry whose nested .options holds the actual primitives.
    const baseInteraction = {
      isChatInputCommand: () => true,
      commandName: "session",
      channelId: "channel_1",
      user: { id: "user_1" },
      deferred: false,
      replied: false,
      options: {
        data: [
          {
            name: "start",
            type: 1,
            options: [
              { name: "channel", value: "team-salary", type: 3 },
              { name: "ephemeral", value: true, type: 5 },
              // Complex object should still be filtered out.
              { name: "user", value: { id: "u1" }, type: 6 },
            ],
          },
        ],
      },
      reply: async () => undefined,
      editReply: async () => undefined,
    };

    inner.emit("interactionCreate", baseInteraction as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.commandName).toBe("session");
    expect(seen[0]!.subcommand).toBe("start");
    expect(seen[0]!.options).toEqual({
      channel: "team-salary",
      ephemeral: true,
    });

    // No-subcommand path: top-level primitives flow through directly,
    // subcommand stays undefined.
    inner.emit("interactionCreate", {
      ...baseInteraction,
      commandName: "ping",
      options: {
        data: [{ name: "loud", value: false, type: 5 }],
      },
    } as never);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.subcommand).toBeUndefined();
    expect(seen[1]!.options).toEqual({ loud: false });
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
