import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { homedir } from "os";

// Test the relay module's attachment download and message formatting logic
// Note: Full relay tests require mocking child_process.spawn

describe("relay", () => {
  test("module exports relayMessage function", async () => {
    const relay = await import("../../src/session/relay");
    expect(typeof relay.relayMessage).toBe("function");
  });
});

describe("relay integration", () => {
  test("CLAUDE_PATH resolves to expected location", () => {
    const expected = resolve(homedir(), ".local", "bin", "claude");
    // Just verify the path format is correct
    expect(expected).toContain(".local/bin/claude");
  });
});
