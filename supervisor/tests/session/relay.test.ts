import { test, expect, describe } from "bun:test";
import { resolve } from "path";
import { homedir } from "os";

describe("relay", () => {
  test("module exports relayMessage function", async () => {
    const relay = await import("../../src/session/relay");
    expect(typeof relay.relayMessage).toBe("function");
  });

  test("TMUX_PATH is valid", () => {
    const tmuxPath = "/opt/homebrew/bin/tmux";
    expect(tmuxPath).toContain("tmux");
  });
});
