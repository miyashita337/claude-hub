import { formatForDiscord } from "./output-formatter";

export interface RelayResult {
  text: string;
  chunks: string[];
  claudeSessionId?: string;
  error?: string;
}

export interface ProgressEvent {
  threadId: string;
  tool: string;
  message: string;
}

export interface LateResponseEvent {
  threadId: string;
  chunks: string[];
  text: string;
}

// Issue #12 (Phase 1): AskUserQuestion fallback. When `claude` raises an
// AskUserQuestion dialog inside a headless supervisor session, the PreToolUse
// hook (`hooks/ask-user-relay.sh`) POSTs the prompt to /ask/:threadId. The
// supervisor process subscribes via `onAskUser` to forward the question to the
// Discord thread, and resolves the request with `resolveAskUser(threadId, ans)`
// once the user replies. The hook then injects `answer` back into Claude's
// `tool_input` via the `updatedInput` PreToolUse contract.
export interface AskUserEvent {
  threadId: string;
  question: string;
  options?: string[];
}

type ProgressCallback = (event: ProgressEvent) => void;
type LateResponseCallback = (event: LateResponseEvent) => void;
type AskUserCallback = (event: AskUserEvent) => void;

interface PendingRequest {
  resolve: (result: RelayResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingAsk {
  resolve: (result: { status: 200 | 504 | 499; answer?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();
const pendingAsks = new Map<string, PendingAsk>();

// /ask/:threadId default timeout. Mirrors the 120s budget from the example in
// Issue #12 body so users have time to type a real answer on mobile Discord.
const DEFAULT_ASK_TIMEOUT_MS = 120_000;
// Cap user-supplied timeouts so a malformed hook payload can't pin a request
// indefinitely. 10 minutes is well above any realistic Discord round-trip.
const MAX_ASK_TIMEOUT_MS = 600_000;

let server: ReturnType<typeof Bun.serve> | null = null;
let relayPort = 0;
let progressCallback: ProgressCallback | null = null;
let lateResponseCallback: LateResponseCallback | null = null;
let askUserCallback: AskUserCallback | null = null;

export function onProgress(callback: ProgressCallback): void {
  progressCallback = callback;
}

export function onLateResponse(callback: LateResponseCallback): void {
  lateResponseCallback = callback;
}

export function onAskUser(callback: AskUserCallback): void {
  askUserCallback = callback;
}

/**
 * Resolve a pending /ask/:threadId request with the user's reply text.
 * No-op when there is no in-flight request for the thread (e.g. the user
 * replied after the request already timed out, or to an unrelated thread).
 */
export function resolveAskUser(threadId: string, answer: string): void {
  const pending = pendingAsks.get(threadId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAsks.delete(threadId);
  pending.resolve({ status: 200, answer });
}

/**
 * Cancel a pending /ask/:threadId request. The waiting POST handler responds
 * with 499 (Client Closed Request, Nginx convention) so the hook script can
 * fall back to the original tool input rather than blocking the session.
 */
export function cancelAskUser(threadId: string): void {
  const pending = pendingAsks.get(threadId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAsks.delete(threadId);
  pending.resolve({ status: 499 });
}

export function startRelayServer(): void {
  if (server) return;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return new Response("ok", { status: 200 });
      }

      // Progress endpoint: PostToolUse hook sends tool progress here
      const progressMatch = url.pathname.match(/^\/progress\/(.+)$/);
      if (progressMatch && req.method === "POST") {
        const rawThreadId = progressMatch[1];
        if (!rawThreadId) {
          return new Response("Invalid thread ID", { status: 400 });
        }
        // Symmetric to manager.ts (encodeURIComponent). progress-relay.sh
        // derives this URL from the same encoded relayUrl, so the threadId
        // arrives encoded and must be decoded before downstream lookups
        // (e.g. manager.touchActivity) can find the session.
        let threadId: string;
        try {
          threadId = decodeURIComponent(rawThreadId);
        } catch {
          return new Response("Invalid thread ID encoding", { status: 400 });
        }
        try {
          const body = await req.json() as Record<string, unknown>;
          const tool = typeof body.tool === "string" ? body.tool : "unknown";
          const message = typeof body.message === "string" ? body.message : "";
          if (progressCallback && message) {
            progressCallback({ threadId, tool, message });
          }
          return new Response("ok", { status: 200 });
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
      }

      // Issue #12 (Phase 1): AskUserQuestion fallback endpoint.
      const askMatch = url.pathname.match(/^\/ask\/(.+)$/);
      if (askMatch && req.method === "POST") {
        const rawThreadId = askMatch[1];
        if (!rawThreadId) {
          return new Response("Invalid thread ID", { status: 400 });
        }
        let threadId: string;
        try {
          threadId = decodeURIComponent(rawThreadId);
        } catch {
          return new Response("Invalid thread ID encoding", { status: 400 });
        }

        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const question =
          typeof body.question === "string" ? body.question.trim() : "";
        if (!question) {
          return new Response(
            JSON.stringify({ error: "question is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const options =
          Array.isArray(body.options) &&
          body.options.every((o) => typeof o === "string")
            ? (body.options as string[])
            : undefined;

        const requested =
          typeof body.timeout_ms === "number" && body.timeout_ms > 0
            ? body.timeout_ms
            : DEFAULT_ASK_TIMEOUT_MS;
        const timeoutMs = Math.min(requested, MAX_ASK_TIMEOUT_MS);

        // Replace any in-flight ask for the same thread (defensive: a runaway
        // hook should not pin two requests). The displaced one resolves 499.
        const existing = pendingAsks.get(threadId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.resolve({ status: 499 });
          pendingAsks.delete(threadId);
        }

        const result = await new Promise<{
          status: 200 | 504 | 499;
          answer?: string;
        }>((resolve) => {
          const timer = setTimeout(() => {
            pendingAsks.delete(threadId);
            resolve({ status: 504 });
          }, timeoutMs);
          pendingAsks.set(threadId, { resolve, timer });

          // Notify subscribers AFTER the entry is registered so a synchronous
          // resolveAskUser call from the callback always finds the pending
          // request. Wrap in try/catch so a buggy callback can't leave the
          // request hanging.
          if (askUserCallback) {
            try {
              askUserCallback({ threadId, question, options });
            } catch (err) {
              console.error("[relay-server] askUserCallback error:", err);
              const pending = pendingAsks.get(threadId);
              if (pending) {
                clearTimeout(pending.timer);
                pendingAsks.delete(threadId);
                resolve({ status: 504 });
              }
            }
          }
        });

        if (result.status === 200) {
          return new Response(JSON.stringify({ answer: result.answer ?? "" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (result.status === 499) {
          return new Response(JSON.stringify({ error: "cancelled" }), {
            status: 499,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "ask timeout" }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        });
      }

      const relayMatch = url.pathname.match(/^\/relay\/(.+)$/);
      if (relayMatch && req.method === "POST") {
        const rawThreadId = relayMatch[1];
        if (!rawThreadId) {
          return new Response("Invalid thread ID", { status: 400 });
        }
        // Symmetric to manager.ts which encodeURIComponent's threadId.
        // decodeURIComponent throws URIError on malformed escapes (e.g. `%ZZ`);
        // treat that as a 400 instead of a 500.
        let threadId: string;
        try {
          threadId = decodeURIComponent(rawThreadId);
        } catch {
          return new Response("Invalid thread ID encoding", { status: 400 });
        }
        let body: Record<string, unknown>;
        try {
          body = await req.json() as Record<string, unknown>;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const text =
          typeof body.text === "string"
            ? body.text
            : typeof body.last_assistant_message === "string"
              ? body.last_assistant_message
              : "";
        const sessionId =
          typeof body.session_id === "string" ? body.session_id : undefined;
        const chunks = formatForDiscord(text);

        const pending = pendingRequests.get(threadId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve({ text, chunks, claudeSessionId: sessionId });
          pendingRequests.delete(threadId);
          return new Response("ok", { status: 200 });
        }

        // Late-arriving Stop event (e.g., Monitor completion split the turn
        // into a second assistant message after the first already resolved).
        // Forward to Discord as a follow-up message so responses aren't lost.
        if (text && lateResponseCallback) {
          try {
            lateResponseCallback({ threadId, chunks, text });
          } catch (err) {
            console.error("[relay-server] lateResponseCallback error:", err);
          }
          return new Response("forwarded", { status: 202 });
        }

        return new Response("Not found", { status: 404 });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  relayPort = server.port ?? 0;
  console.log(`[relay-server] started on port ${relayPort}`);
}

export function stopRelayServer(): void {
  if (!server) return;

  // Clear all pending requests
  for (const [threadId, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.resolve({ text: "", chunks: [], error: "Server stopped" });
    pendingRequests.delete(threadId);
  }
  // Clear all pending /ask requests so a server restart doesn't leak handles.
  for (const [threadId, pending] of pendingAsks) {
    clearTimeout(pending.timer);
    pending.resolve({ status: 499 });
    pendingAsks.delete(threadId);
  }

  server.stop(true);
  server = null;
  relayPort = 0;
  progressCallback = null;
  lateResponseCallback = null;
  askUserCallback = null;
}

export function waitForRelay(
  threadId: string,
  timeoutMs: number
): Promise<RelayResult> {
  const existing = pendingRequests.get(threadId);
  if (existing) {
    console.warn(`[relay-server] WARNING: overwriting pending request for thread ${threadId}. This means a second message was sent before the first finished.`);
    clearTimeout(existing.timer);
    existing.resolve({ text: "", chunks: ["⚠️ 前のメッセージの処理中に新しいメッセージが送信されました。"], error: "Superseded by new message" });
    pendingRequests.delete(threadId);
  }

  return new Promise<RelayResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(threadId);
      resolve({ text: "", chunks: ["⚠️ Claude Code からの応答がタイムアウトしました。"], error: "Response timeout" });
    }, timeoutMs);

    pendingRequests.set(threadId, { resolve, timer });
  });
}

export function cancelRelay(threadId: string): void {
  const pending = pendingRequests.get(threadId);
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve({ text: "", chunks: [], error: "Cancelled" });
    pendingRequests.delete(threadId);
  }
}

export function getRelayPort(): number {
  return relayPort;
}
