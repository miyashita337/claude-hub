// Light unit tests for RealDiscordClient (Issue #144 Phase 1).
//
// These tests verify construction and lifecycle gating without actually
// reaching Discord — the discord.js Client is constructed but never logged in.
// Behavioral E2E coverage lives in Phase 2's lifecycle test, which routes
// through InMemoryDiscordClient and the real tmux + claude-mock.sh.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
    //
    // Issue #32 / S7: the wrapper now enforces access.json before dispatching.
    // Point the runtime loader at a temp policy that allows this sender on the
    // parent channel (requireMention:false so no mention object is needed) so
    // we still exercise the propagation contract. The access gate itself is
    // covered behaviorally below and in tests/config/access-policy.test.ts.
    const dir = mkdtempSync(join(tmpdir(), "real-client-access-"));
    const accessPath = join(dir, "access.json");
    writeFileSync(
      accessPath,
      JSON.stringify({
        groups: {
          parent_1: { requireMention: false, allowFrom: ["user_1"] },
        },
      }),
    );
    const prevAccess = process.env.SUPERVISOR_ACCESS_JSON_PATH;
    process.env.SUPERVISOR_ACCESS_JSON_PATH = accessPath;

    try {
      const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
      const wrapper = new RealDiscordClient("fake-token", { client: inner });
      created.push(wrapper);

      const events: Array<{ threadId: string; content: string; isBot: boolean }> = [];
      wrapper.onThreadMessage((m) => {
        events.push({ threadId: m.threadId, content: m.content, isBot: m.authorBot });
      });

      const baseMessage = {
        author: { bot: false, id: "user_1" },
        channel: { isThread: () => true, id: "thread_1", parentId: "parent_1" },
        mentions: { users: { has: () => false } },
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
    } finally {
      if (prevAccess === undefined)
        delete process.env.SUPERVISOR_ACCESS_JSON_PATH;
      else process.env.SUPERVISOR_ACCESS_JSON_PATH = prevAccess;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RealDiscordClient MessageCreate access enforcement (#32 / S7)", () => {
  const created: RealDiscordClient[] = [];
  let dir: string;
  let accessPath: string;
  const prevAccess = process.env.SUPERVISOR_ACCESS_JSON_PATH;

  const PARENT = "846209781206941736";
  const OWNER = "184695080709324800";
  const OUTSIDER = "999999999999999999";

  afterEach(async () => {
    while (created.length) {
      const c = created.pop()!;
      try {
        await c.stop();
      } catch {
        // best-effort cleanup
      }
    }
    if (prevAccess === undefined) delete process.env.SUPERVISOR_ACCESS_JSON_PATH;
    else process.env.SUPERVISOR_ACCESS_JSON_PATH = prevAccess;
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(policy: unknown | undefined) {
    dir = mkdtempSync(join(tmpdir(), "real-client-deny-"));
    accessPath = join(dir, "access.json");
    if (policy !== undefined) {
      writeFileSync(accessPath, JSON.stringify(policy));
    }
    process.env.SUPERVISOR_ACCESS_JSON_PATH = accessPath;

    const inner = new Client({ intents: [GatewayIntentBits.Guilds] });
    // Stand in for the bot's own user so mention detection has an id to match.
    (inner as unknown as { user: { id: string } }).user = { id: "bot_self" };
    const wrapper = new RealDiscordClient("fake-token", { client: inner });
    created.push(wrapper);

    const events: string[] = [];
    wrapper.onThreadMessage((m) => events.push(m.content));
    return { inner, events };
  }

  function msg(opts: { userId: string; mentioned?: boolean; content: string }) {
    return {
      author: { bot: false, id: opts.userId },
      channel: { isThread: () => true, id: "thread_1", parentId: PARENT },
      mentions: { users: { has: (id: string) => !!opts.mentioned && id === "bot_self" } },
      content: opts.content,
      id: "m",
      attachments: new Map(),
    } as never;
  }

  test("allowlisted + mention → dispatched", () => {
    const { inner, events } = setup({
      groups: { [PARENT]: { requireMention: true, allowFrom: [OWNER] } },
    });
    inner.emit("messageCreate", msg({ userId: OWNER, mentioned: true, content: "ok" }));
    expect(events).toEqual(["ok"]);
  });

  test("non-allowlisted sender → dropped", () => {
    const { inner, events } = setup({
      groups: { [PARENT]: { requireMention: true, allowFrom: [OWNER] } },
    });
    inner.emit("messageCreate", msg({ userId: OUTSIDER, mentioned: true, content: "x" }));
    expect(events).toEqual([]);
  });

  test("requireMention + no mention → dropped", () => {
    const { inner, events } = setup({
      groups: { [PARENT]: { requireMention: true, allowFrom: [OWNER] } },
    });
    inner.emit("messageCreate", msg({ userId: OWNER, mentioned: false, content: "x" }));
    expect(events).toEqual([]);
  });

  test("fail-closed: missing access.json → dropped", () => {
    const { inner, events } = setup(undefined); // no file written
    inner.emit("messageCreate", msg({ userId: OWNER, mentioned: true, content: "x" }));
    expect(events).toEqual([]);
  });

  test("fail-closed: undefined channel → dropped", () => {
    const { inner, events } = setup({
      groups: { "111111111111111111": { requireMention: false, allowFrom: [OWNER] } },
    });
    inner.emit("messageCreate", msg({ userId: OWNER, mentioned: true, content: "x" }));
    expect(events).toEqual([]);
  });
});
