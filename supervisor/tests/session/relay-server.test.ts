import { test, expect, describe, afterEach } from "bun:test";
import {
  startRelayServer,
  stopRelayServer,
  waitForRelay,
  getRelayPort,
  onLateResponse,
  type LateResponseEvent,
} from "../../src/session/relay-server";

describe("relay-server", () => {
  afterEach(() => {
    stopRelayServer();
  });

  test("startRelayServer starts HTTP server on configured port", async () => {
    startRelayServer();
    const port = getRelayPort();
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
  });

  test("POST /relay/:threadId resolves pending promise", async () => {
    startRelayServer();
    const port = getRelayPort();

    const promise = waitForRelay("thread-abc", 5000);

    await fetch(`http://localhost:${port}/relay/thread-abc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Hello from Claude",
        session_id: "sess-123",
      }),
    });

    const result = await promise;
    expect(result.text).toBe("Hello from Claude");
    expect(result.claudeSessionId).toBe("sess-123");
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("waitForRelay times out if no POST received", async () => {
    startRelayServer();

    const result = await waitForRelay("thread-timeout", 100);
    expect(result.error).toBe("Response timeout");
  });

  test("POST to unknown threadId returns 404", async () => {
    startRelayServer();
    const port = getRelayPort();

    const res = await fetch(`http://localhost:${port}/relay/unknown-thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });
    expect(res.status).toBe(404);
  });

  test("stopRelayServer stops the server", async () => {
    startRelayServer();
    const port = getRelayPort();
    stopRelayServer();

    try {
      await fetch(`http://localhost:${port}/health`);
      expect(true).toBe(false); // Should not reach here
    } catch {
      expect(true).toBe(true);
    }
  });

  test("late-arriving POST invokes onLateResponse callback (202) instead of dropping", async () => {
    startRelayServer();
    const port = getRelayPort();

    const received: LateResponseEvent[] = [];
    onLateResponse((event) => received.push(event));

    // Simulate Monitor pattern: first Stop POST resolves the pending request
    const promise = waitForRelay("thread-monitor", 5000);
    await fetch(`http://localhost:${port}/relay/thread-monitor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Script is running in the background." }),
    });
    await promise;

    // Second Stop POST arrives after Monitor completes and Claude produces
    // the real answer — must be forwarded, not dropped as 404.
    const res = await fetch(`http://localhost:${port}/relay/thread-monitor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "18 件の下書きがあります。" }),
    });

    expect(res.status).toBe(202);
    expect(received.length).toBe(1);
    const late = received[0]!;
    expect(late.threadId).toBe("thread-monitor");
    expect(late.text).toBe("18 件の下書きがあります。");
    expect(late.chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("POST with empty text and no pending returns 404 even with late handler", async () => {
    startRelayServer();
    const port = getRelayPort();

    onLateResponse(() => {});

    const res = await fetch(`http://localhost:${port}/relay/orphan-thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(404);
  });

  test("multiple threads can wait concurrently", async () => {
    startRelayServer();
    const port = getRelayPort();

    const promise1 = waitForRelay("thread-1", 5000);
    const promise2 = waitForRelay("thread-2", 5000);

    await fetch(`http://localhost:${port}/relay/thread-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Response 2", session_id: "s2" }),
    });

    await fetch(`http://localhost:${port}/relay/thread-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Response 1", session_id: "s1" }),
    });

    const result1 = await promise1;
    const result2 = await promise2;
    expect(result1.text).toBe("Response 1");
    expect(result2.text).toBe("Response 2");
  });
});
