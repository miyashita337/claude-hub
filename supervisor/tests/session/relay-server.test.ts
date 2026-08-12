import { test, expect, describe, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  startRelayServer,
  stopRelayServer,
  waitForRelay,
  getRelayPort,
  onLateResponse,
  onProgress,
  onSessionsQuery,
  RELAY_TIMEOUT_USER_MESSAGE,
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
  RELAY_IDLE_TIMEOUT_SEC,
  readAskTimeoutMs,
  formatAskWaitLabel,
  askWaitNotice,
  askExpiredNotice,
  onAskUser,
  onAskExpired,
  resolveAskUser,
  hasPendingAsk,
  hasRecentAsk,
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

  // Issue #255 (proposal B): the timeout chunk must NOT assert the session died
  // — it is usually still alive and the late-response path forwards the result.
  test("timeout chunk reassures the session may still be running (Issue #255)", async () => {
    startRelayServer();

    const result = await waitForRelay("thread-timeout-msg", 100);
    expect(result.chunks).toEqual([RELAY_TIMEOUT_USER_MESSAGE]);
    // Wording acceptance: mentions the session may still be running.
    expect(result.chunks[0]).toContain("稼働中");
    // Must drop the old "応答がタイムアウトしました" dead-session assertion.
    expect(result.chunks[0]).not.toContain("応答がタイムアウトしました");
    // `error` stays machine-stable for callers that key on it.
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

// Issue #255 (proposal E): the AskUserQuestion relay timeout was raised
// 120s → 300s so a 会長 answering on mobile Discord isn't dropped after 2 min.
// The server default and the curl `--max-time` in hooks/ask-user-relay.sh are a
// coupled pair (RW-035-style implicit contract); lock both here so they can't
// drift apart and re-break the late reply.
describe("ask timeout (Issue #255, proposal E)", () => {
  test("DEFAULT_ASK_TIMEOUT_MS is raised to at least 300s and stays <= MAX", () => {
    expect(DEFAULT_ASK_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    expect(DEFAULT_ASK_TIMEOUT_MS).toBeLessThanOrEqual(MAX_ASK_TIMEOUT_MS);
  });

  test("ask-user-relay.sh --max-time covers the server default (curl must not give up first)", () => {
    const hookPath = resolve(
      import.meta.dir,
      "../../hooks/ask-user-relay.sh",
    );
    const hook = readFileSync(hookPath, "utf8");
    const match = hook.match(/--max-time\s+(\d+)/);
    expect(match).not.toBeNull();
    const maxTimeSeconds = Number(match![1]);
    // INVARIANT (lower bound): curl budget (s) * 1000 must be >= the server
    // default (ms), otherwise curl aborts before the user can answer and the
    // reply is wasted.
    expect(maxTimeSeconds * 1000).toBeGreaterThanOrEqual(DEFAULT_ASK_TIMEOUT_MS);
    // INVARIANT (upper bound): curl must not wait beyond the server's hard cap —
    // the server can never answer later than MAX_ASK_TIMEOUT_MS, so a larger
    // --max-time would just hang the hook with no chance of a reply.
    expect(maxTimeSeconds * 1000).toBeLessThanOrEqual(MAX_ASK_TIMEOUT_MS);
  });
});

/**
 * Issue #416: the ask wait goes from 5 minutes to 5 hours, because the 会長
 * reads the morning report on mobile hours after delivery. Four values have to
 * move together (server default, server cap, curl budget, Claude Code's hook
 * timeout) and the socket has to survive the wait.
 *
 * On the idle timeout specifically, measured on Bun 1.3.11 against a real
 * server holding 20s: a GET whose body is never read is cut at ~12s, but a POST
 * whose JSON body IS read completes normally — and POST-with-body is what
 * hooks/ask-user-relay.sh sends. So the behavioural test below passes with or
 * without `idleTimeout: 0`; the structural test is what actually locks the
 * option in place.
 */
describe("ask timeout (Issue #416, 5 hours)", () => {
  const HOUR = 60 * 60 * 1000;

  test("the default is 5 hours and the cap is above it", () => {
    expect(DEFAULT_ASK_TIMEOUT_MS).toBe(5 * HOUR);
    expect(MAX_ASK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_ASK_TIMEOUT_MS);
  });

  test("readAskTimeoutMs: default / env override / clamp / invalid input", () => {
    expect(readAskTimeoutMs({})).toBe(DEFAULT_ASK_TIMEOUT_MS);
    expect(readAskTimeoutMs({ ASK_TIMEOUT_MS: String(2 * HOUR) })).toBe(2 * HOUR);
    // Never past the cap: the curl budget in the hook is a static literal and
    // cannot follow an env var, so exceeding it would just hang the hook.
    expect(readAskTimeoutMs({ ASK_TIMEOUT_MS: String(99 * HOUR) })).toBe(
      MAX_ASK_TIMEOUT_MS,
    );
    for (const bad of ["abc", "0", "-5", ""]) {
      expect(readAskTimeoutMs({ ASK_TIMEOUT_MS: bad })).toBe(
        DEFAULT_ASK_TIMEOUT_MS,
      );
    }
  });

  test("the thread notices state the real wait, not a stale hardcoded one", () => {
    expect(formatAskWaitLabel(5 * HOUR)).toBe("約 5 時間");
    expect(formatAskWaitLabel(30 * 60_000)).toBe("約 30 分");
    // The pre-#416 wording promised "約 5 分" — the value it described had
    // already changed twice underneath it.
    expect(askWaitNotice(5 * HOUR)).toContain("約 5 時間");
    expect(askWaitNotice(5 * HOUR)).not.toContain("約 5 分");
    // #423: the notice must not imply the TUI fallback decides anything.
    expect(askWaitNotice(5 * HOUR)).toContain("自動で選ばれることはありません");
    expect(askExpiredNotice(5 * HOUR)).toContain("自動では回答していません");
  });

  test("the server pins idleTimeout off so a multi-hour hold is our choice, not Bun's default", () => {
    // Bun's default is 10s and its maximum is 255s, so a 5h wait is only
    // expressible as 0. This assertion exists because no behavioural test can
    // catch the option being dropped (see the block comment above) — a 5h hold
    // currently survives by way of an undocumented Bun behaviour, and this is
    // what makes it survive by configuration instead.
    expect(RELAY_IDLE_TIMEOUT_SEC).toBe(0);
  });

  test(
    "an in-flight /ask survives 30s without the socket being closed (Journey AC #2)",
    async () => {
      startRelayServer();
      const port = getRelayPort();
      const HOLD_MS = 30_000; // > Bun's 10s default idleTimeout (cut observed at 13s)

      onAskUser((event) => {
        setTimeout(() => resolveAskUser(event.threadId, "遅れて届いた回答"), HOLD_MS);
      });

      const started = Date.now();
      const res = await fetch(`http://localhost:${port}/ask/thread-slow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "どちらにしますか？" }),
      });
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ answer: "遅れて届いた回答" });
      // The hold really elapsed — a fast 200 would mean the test proved nothing.
      // This guards the *behaviour* (an unanswered ask stays open long enough to
      // answer) against any future change that closes it early, whether that is
      // an idle timeout, a keep-alive limit, or a body-handling change in Bun.
      expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS - 500);
    },
    60_000,
  );

  test("an expired ask notifies onAskExpired so Discord can say so (AC-3)", async () => {
    startRelayServer();
    const port = getRelayPort();
    const expired: Array<{ threadId: string; question: string; timeoutMs: number }> =
      [];

    onAskUser(() => {}); // subscriber present, but never answers
    onAskExpired((event) => expired.push(event));

    const res = await fetch(`http://localhost:${port}/ask/thread-expire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "放置される質問", timeout_ms: 80 }),
    });

    expect(res.status).toBe(504);
    expect(expired).toEqual([
      { threadId: "thread-expire", question: "放置される質問", timeoutMs: 80 },
    ]);
  });

  test("hasRecentAsk stays true after the ask ends, so the fallback dialog is protected (#423)", async () => {
    startRelayServer();
    const port = getRelayPort();
    onAskUser(() => {});

    await fetch(`http://localhost:${port}/ask/thread-recent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q", timeout_ms: 50 }),
    });

    // The TUI dialog the hook falls back to only appears AFTER the request
    // settles, which is exactly when hasPendingAsk goes false. hasRecentAsk is
    // what the dialog watchdog consults, so it must outlive the request.
    expect(hasPendingAsk("thread-recent")).toBe(false);
    expect(hasRecentAsk("thread-recent")).toBe(true);
    // Window-scoped, not permanent: an ask from long ago must not disable
    // auto-accept for the rest of the session.
    expect(hasRecentAsk("thread-recent", 0)).toBe(false);
    expect(hasRecentAsk("never-asked")).toBe(false);
  });
});
