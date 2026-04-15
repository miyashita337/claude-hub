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

type ProgressCallback = (event: ProgressEvent) => void;
type LateResponseCallback = (event: LateResponseEvent) => void;

interface PendingRequest {
  resolve: (result: RelayResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

let server: ReturnType<typeof Bun.serve> | null = null;
let relayPort = 0;
let progressCallback: ProgressCallback | null = null;
let lateResponseCallback: LateResponseCallback | null = null;

export function onProgress(callback: ProgressCallback): void {
  progressCallback = callback;
}

export function onLateResponse(callback: LateResponseCallback): void {
  lateResponseCallback = callback;
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
        const threadId = progressMatch[1];
        if (!threadId) {
          return new Response("Invalid thread ID", { status: 400 });
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

      const relayMatch = url.pathname.match(/^\/relay\/(.+)$/);
      if (relayMatch && req.method === "POST") {
        const threadId = relayMatch[1];
        if (!threadId) {
          return new Response("Invalid thread ID", { status: 400 });
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

  server.stop(true);
  server = null;
  relayPort = 0;
  progressCallback = null;
  lateResponseCallback = null;
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
