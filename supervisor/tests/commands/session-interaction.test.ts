import { test, expect, describe } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { safeRespond } from "../../src/commands/safe-respond";

/**
 * Issue #27 (Task 2, root-fix): the six command handlers used to duplicate
 * `if (interaction.deferred || interaction.replied) { editReply } else { reply }`
 * in every catch block. A forgotten copy → Discord `40060` ("already
 * acknowledged") → the global handler swallows it → the user silently gets no
 * response. `safeRespond` centralizes the routing so the guard cannot be
 * forgotten.
 *
 * These are behavioral tests against a recording fake interaction (replacing the
 * previous source-text grep, which was a fragile form-check). They lock the
 * acknowledged-state routing deterministically without a live Discord gateway.
 */

interface RecordedCall {
  api: "reply" | "editReply";
  payload: Record<string, unknown>;
}

function makeFakeInteraction(state: {
  deferred: boolean;
  replied: boolean;
}): { interaction: ChatInputCommandInteraction; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const interaction = {
    deferred: state.deferred,
    replied: state.replied,
    async reply(payload: Record<string, unknown>) {
      calls.push({ api: "reply", payload });
    },
    async editReply(payload: Record<string, unknown>) {
      calls.push({ api: "editReply", payload });
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, calls };
}

describe("safeRespond acknowledged-state routing (#27)", () => {
  test("not acknowledged → reply (never editReply)", async () => {
    const { interaction, calls } = makeFakeInteraction({
      deferred: false,
      replied: false,
    });
    await safeRespond(interaction, { content: "hello" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.api).toBe("reply");
    expect(calls[0]!.payload.content).toBe("hello");
  });

  test("deferred → editReply (never a second reply → no 40060)", async () => {
    const { interaction, calls } = makeFakeInteraction({
      deferred: true,
      replied: false,
    });
    await safeRespond(interaction, { content: "done" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.api).toBe("editReply");
    expect(calls[0]!.payload.content).toBe("done");
  });

  test("already replied → editReply (never a second reply → no 40060)", async () => {
    const { interaction, calls } = makeFakeInteraction({
      deferred: false,
      replied: true,
    });
    await safeRespond(interaction, { content: "again" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.api).toBe("editReply");
  });

  test("ephemeral applies flags:64 only on the fresh reply path", async () => {
    const fresh = makeFakeInteraction({ deferred: false, replied: false });
    await safeRespond(fresh.interaction, { content: "x", ephemeral: true });
    expect(fresh.calls[0]!.payload.flags).toBe(64);

    // editReply cannot change ephemerality (set at defer time) — flag must NOT
    // be forwarded, or discord.js rejects the unknown option.
    const deferred = makeFakeInteraction({ deferred: true, replied: false });
    await safeRespond(deferred.interaction, { content: "x", ephemeral: true });
    expect(deferred.calls[0]!.payload.flags).toBeUndefined();
  });

  test("ephemeral omitted → no flags on reply", async () => {
    const { interaction, calls } = makeFakeInteraction({
      deferred: false,
      replied: false,
    });
    await safeRespond(interaction, { content: "x" });
    expect(calls[0]!.payload.flags).toBeUndefined();
  });

  test("embeds are forwarded on both paths", async () => {
    const fakeEmbed = { name: "e" } as unknown as import("discord.js").EmbedBuilder;
    const fresh = makeFakeInteraction({ deferred: false, replied: false });
    await safeRespond(fresh.interaction, { embeds: [fakeEmbed] });
    expect((fresh.calls[0]!.payload.embeds as unknown[])).toHaveLength(1);

    const deferred = makeFakeInteraction({ deferred: true, replied: false });
    await safeRespond(deferred.interaction, { embeds: [fakeEmbed] });
    expect((deferred.calls[0]!.payload.embeds as unknown[])).toHaveLength(1);
  });
});
