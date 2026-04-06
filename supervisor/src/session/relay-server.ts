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

type ProgressCallback = (event: ProgressEvent) => void;

interface PendingRequest {
  resolve: (result: RelayResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

let server: ReturnType<typeof Bun.serve> | null = null;
let relayPort = 0;
let progressCallback: ProgressCallback | null = null;

export function onProgress(callback: ProgressCallback): void {
  progressCallback = callback;
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
        const pending = pendingRequests.get(threadId);

        if (!pending) {
          return new Response("Not found", { status: 404 });
        }

        try {
          const body = await req.json() as Record<string, unknown>;
          const text =
            typeof body.text === "string"
              ? body.text
              : typeof body.last_assistant_message === "string"
                ? body.last_assistant_message
                : "";
          const sessionId =
            typeof body.session_id === "string" ? body.session_id : undefined;
          const chunks = formatForDiscord(text);

          clearTimeout(pending.timer);
          pending.resolve({ text, chunks, claudeSessionId: sessionId });
          pendingRequests.delete(threadId);

          return new Response("ok", { status: 200 });
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  relayPort = server.port;
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
}

export function waitForRelay(
  threadId: string,
  timeoutMs: number
): Promise<RelayResult> {
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
