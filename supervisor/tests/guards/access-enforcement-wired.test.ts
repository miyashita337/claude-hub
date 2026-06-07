import { test, expect, describe } from "bun:test";

/**
 * Issue #32 / S7 (Critical): guard that the runtime access enforcement stays
 * wired at all three relay entry points. Behavioral coverage lives in
 * tests/config/access-policy.test.ts, tests/discord/real-client.test.ts, and
 * tests/commands/session-start-access.test.ts; this guard prevents a future
 * refactor from silently deleting or reordering the gate so the gate is never
 * bypassed (defense-in-depth against the lateral-movement regression).
 */

async function read(path: string): Promise<string> {
  return Bun.file(path).text();
}

describe("access enforcement is wired (#32 / S7)", () => {
  test("bot.ts evaluates access before relaying (sendMessage)", async () => {
    const src = await read("src/bot.ts");
    expect(src).toContain("evaluateAccess");
    const gateIdx = src.indexOf("evaluateAccess");
    const relayIdx = src.indexOf("sessionManager.sendMessage");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(relayIdx).toBeGreaterThan(-1);
    // The gate must appear before the relay call so a denied message never
    // reaches the session.
    expect(gateIdx).toBeLessThan(relayIdx);
    // Fail-closed: a denied decision returns without relaying.
    expect(src).toContain("decision.allowed");
  });

  test("real-client.ts evaluates access before dispatching thread handlers", async () => {
    const src = await read("src/discord/real-client.ts");
    expect(src).toContain("evaluateAccess");
    const gateIdx = src.indexOf("evaluateAccess");
    const dispatchIdx = src.indexOf("for (const h of this.threadHandlers)");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(dispatchIdx);
  });

  test("session.ts handleStart evaluates access before starting a session", async () => {
    const src = await read("src/commands/session.ts");
    expect(src).toContain("evaluateAccess");
    const gateIdx = src.indexOf("evaluateAccess");
    const startIdx = src.indexOf("sessionManager.start(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(startIdx);
  });

  test("denial logs do not interpolate raw user/channel ids", async () => {
    // The structured denial logs must reference the coarse `decision.reason`
    // enum and thread id, never the sender/channel snowflake or message body.
    for (const path of [
      "src/bot.ts",
      "src/discord/real-client.ts",
      "src/commands/session.ts",
    ]) {
      const src = await read(path);
      const denialLines = src
        .split("\n")
        .filter((l) => /Access denied|access denied/.test(l));
      expect(denialLines.length).toBeGreaterThan(0);
      for (const line of denialLines) {
        // Must log the reason enum.
        expect(line).toContain("reason=");
        // Must NOT log the sender id or message body.
        expect(line).not.toContain("message.author.id");
        expect(line).not.toContain("interaction.user.id");
        expect(line).not.toContain("message.content");
      }
    }
  });
});

describe("dispatch transport is wired fail-closed (#32 / S7)", () => {
  test("bot.ts intercepts dispatch BEFORE the bot/webhook drop", async () => {
    const src = await read("src/bot.ts");
    // The dispatch interception must run before the `message.author.bot` drop,
    // otherwise an external source (a bot/webhook) can never trigger it.
    const dispatchIdx = src.indexOf("handleDispatchMessage(message)");
    const botDropIdx = src.indexOf("if (message.author.bot) return;");
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(botDropIdx).toBeGreaterThan(-1);
    // The call inside the MessageCreate handler precedes the bot drop.
    expect(dispatchIdx).toBeLessThan(botDropIdx);
  });

  test("bot.ts authorizes the source before parsing/starting (fail-closed)", async () => {
    const src = await read("src/bot.ts");
    expect(src).toContain("isDispatchSourceAllowed");
    const authIdx = src.indexOf("isDispatchSourceAllowed");
    const parseIdx = src.indexOf("parseDispatchCommand(content)");
    const runIdx = src.indexOf("runDispatch(");
    expect(authIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(-1);
    // Source authorization must precede both parsing and the actual start.
    expect(authIdx).toBeLessThan(parseIdx);
    expect(authIdx).toBeLessThan(runIdx);
    // A denied decision must not proceed to runDispatch.
    expect(src).toContain("decision.allowed");
  });

  test("dispatch denial logs do not interpolate raw source/channel ids or body", async () => {
    const src = await read("src/bot.ts");
    const denialLines = src
      .split("\n")
      .filter((l) => /Dispatch denied|Dispatch rejected/.test(l));
    expect(denialLines.length).toBeGreaterThan(0);
    for (const line of denialLines) {
      expect(line).not.toContain("message.author.id");
      expect(line).not.toContain("message.content");
    }
  });
});
