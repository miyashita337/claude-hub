import { test, expect, describe, afterEach } from "bun:test";
import {
  startRelayServer,
  stopRelayServer,
  waitForRelay,
  getRelayPort,
  onLateResponse,
  onProgress,
  onSessionsQuery,
  type LateResponseEvent,
  type ProgressEvent,
} from "../../src/session/relay-server";
import { MAX_SESSIONS } from "../../src/config/channels";
import type { SessionHealthInfo } from "../../src/session/types";

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

  // Issue #204: context_tokens forwarded by the Stop hook
  test("POST parses a valid context_tokens into RelayResult", async () => {
    startRelayServer();
    const port = getRelayPort();
    const promise = waitForRelay("thread-ctx", 5000);
    await fetch(`http://localhost:${port}/relay/thread-ctx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", session_id: "s", context_tokens: 350000 }),
    });
    const result = await promise;
    expect(result.contextTokens).toBe(350000);
  });

  test("POST omits contextTokens when absent or invalid", async () => {
    startRelayServer();
    const port = getRelayPort();

    const p1 = waitForRelay("thread-noctx", 5000);
    await fetch(`http://localhost:${port}/relay/thread-noctx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", session_id: "s" }),
    });
    expect((await p1).contextTokens).toBeUndefined();

    const p2 = waitForRelay("thread-badctx", 5000);
    await fetch(`http://localhost:${port}/relay/thread-badctx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", session_id: "s", context_tokens: "lots" }),
    });
    expect((await p2).contextTokens).toBeUndefined();

    const p3 = waitForRelay("thread-negctx", 5000);
    await fetch(`http://localhost:${port}/relay/thread-negctx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", session_id: "s", context_tokens: -5 }),
    });
    expect((await p3).contextTokens).toBeUndefined();
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

  // Issue #204: a late Stop event must carry context_tokens so the budget check
  // runs on the Monitor-split path too (not just the resolved relay).
  test("late-arriving POST forwards context_tokens to onLateResponse", async () => {
    startRelayServer();
    const port = getRelayPort();

    const received: LateResponseEvent[] = [];
    onLateResponse((event) => received.push(event));

    const promise = waitForRelay("thread-late-ctx", 5000);
    await fetch(`http://localhost:${port}/relay/thread-late-ctx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "first" }),
    });
    await promise;

    await fetch(`http://localhost:${port}/relay/thread-late-ctx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "second", context_tokens: 820000 }),
    });

    expect(received.length).toBe(1);
    expect(received[0]!.contextTokens).toBe(820000);
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

  // Issue #98: thread IDs are encoded by manager.ts at URL build time and
  // must round-trip through relay-server.ts even if they ever contain
  // characters that would otherwise be ambiguous in a URL path.
  test.each([
    ["plain-numeric", "1234567890123456"],
    ["with-slash", "thread/with/slash"],
    ["with-question", "thread?with=query"],
    ["with-hash", "thread#fragment"],
    ["with-percent", "thread%percent"],
    ["with-space", "thread with space"],
    ["with-non-ascii", "スレッドID"],
  ])("round-trips threadId `%s` through encode/decode", async (_label, threadId) => {
    startRelayServer();
    const port = getRelayPort();

    const promise = waitForRelay(threadId, 5000);

    const res = await fetch(
      `http://localhost:${port}/relay/${encodeURIComponent(threadId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `hello ${threadId}`, session_id: "s" }),
      },
    );
    expect(res.status).toBe(200);

    const result = await promise;
    expect(result.text).toBe(`hello ${threadId}`);
  });

  test("returns 400 for malformed percent-encoding in URL", async () => {
    startRelayServer();
    const port = getRelayPort();

    // `%ZZ` is not a valid percent-escape sequence and decodeURIComponent
    // throws URIError on it. The server must respond 400, not 500.
    const res = await fetch(`http://localhost:${port}/relay/%ZZ`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  // Issue #98 / PR #124 review: /progress/ endpoint must apply the same
  // decodeURIComponent so progress-relay.sh callbacks for special-char
  // thread IDs reach the right session via manager.touchActivity.
  test.each([
    ["plain-numeric", "1234567890123456"],
    ["with-slash", "thread/with/slash"],
    ["with-non-ascii", "スレッドID"],
  ])(
    "/progress/ round-trips threadId `%s` through encode/decode",
    async (_label, threadId) => {
      startRelayServer();
      const port = getRelayPort();

      const received: ProgressEvent[] = [];
      onProgress((event) => received.push(event));

      const res = await fetch(
        `http://localhost:${port}/progress/${encodeURIComponent(threadId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "Bash", message: `running on ${threadId}` }),
        },
      );
      expect(res.status).toBe(200);
      expect(received.length).toBe(1);
      expect(received[0]!.threadId).toBe(threadId);
      expect(received[0]!.message).toBe(`running on ${threadId}`);
    },
  );

  test("/progress/ returns 400 for malformed percent-encoding in URL", async () => {
    startRelayServer();
    const port = getRelayPort();

    const res = await fetch(`http://localhost:${port}/progress/%ZZ`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "Bash", message: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  // Issue #78 (AC-4): GET /health/sessions exposes a read-only snapshot of
  // running sessions so an E2E harness can verify the thread → tmux mapping.
  test("GET /health/sessions returns empty list (200) when no provider registered", async () => {
    startRelayServer();
    const port = getRelayPort();

    const res = await fetch(`http://localhost:${port}/health/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      max: number;
      sessions: SessionHealthInfo[];
    };
    expect(body).toEqual({ count: 0, max: MAX_SESSIONS, sessions: [] });
  });

  test("GET /health/sessions returns the registered provider's snapshot", async () => {
    startRelayServer();
    const port = getRelayPort();

    const snapshot: SessionHealthInfo[] = [
      {
        threadId: "1234567890123456789",
        tmuxSession: "claude-123456789012",
        channelName: "channel-primary",
        status: "running",
        startedAt: "2026-06-05T00:00:00.000Z",
        lastActivityAt: "2026-06-05T00:01:00.000Z",
      },
    ];
    onSessionsQuery(() => snapshot);

    const res = await fetch(`http://localhost:${port}/health/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      max: number;
      sessions: SessionHealthInfo[];
    };
    expect(body.count).toBe(1);
    expect(body.max).toBe(MAX_SESSIONS);
    expect(body.sessions).toEqual(snapshot);
    // AC-4: the tmux session name follows claude-<threadId[..12]>.
    expect(body.sessions[0]!.tmuxSession).toBe(
      `claude-${snapshot[0]!.threadId.slice(0, 12)}`,
    );
  });

  test("GET /health/sessions provider is cleared on stopRelayServer (no leak across restarts)", async () => {
    startRelayServer();
    onSessionsQuery(() => [
      {
        threadId: "leaky",
        tmuxSession: "claude-leaky",
        channelName: "c",
        status: "running",
        startedAt: "2026-06-05T00:00:00.000Z",
        lastActivityAt: "2026-06-05T00:00:00.000Z",
      },
    ]);
    stopRelayServer();

    // Restart without re-registering — must fall back to the empty default.
    startRelayServer();
    const port = getRelayPort();
    const res = await fetch(`http://localhost:${port}/health/sessions`);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(0);
  });

  test("POST /health/sessions is not a valid route (falls through to 404)", async () => {
    startRelayServer();
    const port = getRelayPort();

    const res = await fetch(`http://localhost:${port}/health/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
