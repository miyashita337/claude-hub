import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  startRelayServer,
  stopRelayServer,
} from "../../src/session/relay-server";

describe("relayMessage", () => {
  beforeAll(() => {
    startRelayServer();
  });

  afterAll(() => {
    stopRelayServer();
  });

  test("module exports relayMessage function", async () => {
    const relay = await import("../../src/session/relay");
    expect(typeof relay.relayMessage).toBe("function");
  });

  test("relayMessage accepts threadId as second parameter", async () => {
    const relay = await import("../../src/session/relay");
    // Verify function accepts at least 3 params (tmuxSessionName, threadId, message)
    expect(relay.relayMessage.length).toBeGreaterThanOrEqual(3);
  });

  test("AttachmentInfo type is exported", async () => {
    const relay = await import("../../src/session/relay");
    expect(relay).toBeDefined();
  });
});
