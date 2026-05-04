// Tests for the AskUserQuestion → Discord relay (Issue #12, Phase 1).
//
// The relay server exposes POST /ask/:threadId where:
//   - request body  : { question: string, options?: string[] }
//   - response body : { answer: string } once the user replies in Discord
//
// Mirrors the /relay and /progress endpoints' encode/decode contract.
// The supervisor process registers an `onAskUser` callback that publishes the
// question to the Discord thread; the user's reply is delivered back via
// `resolveAskUser(threadId, answer)`.
import { test, expect, describe, afterEach } from "bun:test";
import {
  startRelayServer,
  stopRelayServer,
  getRelayPort,
  onAskUser,
  resolveAskUser,
  cancelAskUser,
  type AskUserEvent,
} from "../../src/session/relay-server";

describe("ask-user-relay (/ask/:threadId)", () => {
  afterEach(() => {
    stopRelayServer();
  });

  test("POST /ask/:threadId forwards question to onAskUser callback and resolves with user answer", async () => {
    startRelayServer();
    const port = getRelayPort();

    const received: AskUserEvent[] = [];
    onAskUser((event) => {
      received.push(event);
      // Simulate the supervisor publishing to Discord and the user replying.
      // The reply must reach the in-flight POST /ask handler.
      setTimeout(() => resolveAskUser(event.threadId, "use PR #42"), 10);
    });

    const res = await fetch(`http://localhost:${port}/ask/thread-ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Which PR did you mean?" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string };
    expect(body.answer).toBe("use PR #42");
    expect(received.length).toBe(1);
    expect(received[0]!.question).toBe("Which PR did you mean?");
    expect(received[0]!.threadId).toBe("thread-ask");
  });

  test("POST /ask/:threadId returns 400 when question field is missing or empty", async () => {
    startRelayServer();
    const port = getRelayPort();

    onAskUser(() => {
      // Should never fire for invalid input
    });

    const resMissing = await fetch(`http://localhost:${port}/ask/thread-x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resMissing.status).toBe(400);

    const resEmpty = await fetch(`http://localhost:${port}/ask/thread-x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "" }),
    });
    expect(resEmpty.status).toBe(400);
  });

  test("POST /ask/:threadId returns 400 for invalid JSON", async () => {
    startRelayServer();
    const port = getRelayPort();

    const res = await fetch(`http://localhost:${port}/ask/thread-x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  test("POST /ask/:threadId times out and resolves with 504 if no answer arrives", async () => {
    startRelayServer();
    const port = getRelayPort();

    // No onAskUser callback set: the question is queued but never resolved.
    onAskUser(() => {
      // Intentionally no resolveAskUser call.
    });

    const res = await fetch(`http://localhost:${port}/ask/thread-timeout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Will time out", timeout_ms: 50 }),
    });

    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  test("cancelAskUser clears the pending request and POST resolves with 499", async () => {
    startRelayServer();
    const port = getRelayPort();

    onAskUser((event) => {
      setTimeout(() => cancelAskUser(event.threadId), 10);
    });

    const res = await fetch(`http://localhost:${port}/ask/thread-cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Cancel me", timeout_ms: 5000 }),
    });

    expect(res.status).toBe(499);
  });

  test("resolveAskUser on unknown thread is a no-op (does not throw)", () => {
    startRelayServer();
    expect(() => resolveAskUser("not-pending", "ignored")).not.toThrow();
  });

  test("POST /ask/:threadId returns 503 immediately when no onAskUser subscriber is registered", async () => {
    // Regression: without this fast-fail, a hook would block for the full
    // DEFAULT_ASK_TIMEOUT_MS (~120s) before falling back to TUI behaviour
    // (review: coderabbitai on PR #142, comment 3179499098).
    startRelayServer();
    const port = getRelayPort();

    const started = Date.now();
    const res = await fetch(`http://localhost:${port}/ask/thread-no-sub`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Anyone listening?", timeout_ms: 5000 }),
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503);
    expect(elapsed).toBeLessThan(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ask relay unavailable");
  });

  test.each([
    ["plain-numeric", "1234567890123456"],
    ["with-slash", "thread/with/slash"],
    ["with-non-ascii", "スレッドID"],
  ])(
    "/ask/ round-trips threadId `%s` through encode/decode",
    async (_label, threadId) => {
      startRelayServer();
      const port = getRelayPort();

      onAskUser((event) => {
        // Verify the decoded threadId matches what relay-server delivered.
        expect(event.threadId).toBe(threadId);
        setTimeout(() => resolveAskUser(threadId, `answer for ${threadId}`), 10);
      });

      const res = await fetch(
        `http://localhost:${port}/ask/${encodeURIComponent(threadId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: "round trip?" }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { answer: string };
      expect(body.answer).toBe(`answer for ${threadId}`);
    },
  );

  test("/ask/ returns 400 for malformed percent-encoding in URL", async () => {
    startRelayServer();
    const port = getRelayPort();

    const res = await fetch(`http://localhost:${port}/ask/%ZZ`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hi" }),
    });
    expect(res.status).toBe(400);
  });
});
