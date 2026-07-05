import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { formatForDiscord } from "./output-formatter";
import { MAX_SESSIONS } from "../config/channels";
import type { SessionHealthInfo } from "./types";

export interface RelayResult {
  text: string;
  chunks: string[];
  claudeSessionId?: string;
  error?: string;
  /**
   * Session's current context token count at the moment the Stop hook fired
   * (Issue #204). Forwarded by `hooks/stop-relay.sh`. Absent when the hook
   * could not compute it (no transcript / older hook). Consumers use it to warn
   * the Discord thread when a session enters context-rot territory.
   */
  contextTokens?: number;
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
  /** Session context token count for this late turn (Issue #204), if reported
   *  by the Stop hook. Lets the late-response path warn on context rot too. */
  contextTokens?: number;
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

// Epic #316 Phase 3 (#320, ADR-002 D5): claude-hub work セッション経路の起動口。
// ローカルのオーケストレーター CC セッション（session-ctl start-hub-worker）が
// `POST /hub-work` に {branch, issueNumber, selector?} を投げると、bot.ts が
// 登録したハンドラ（src/session/hub-work.ts の runHubWork）へ委譲される。
// サーバは loopback-only bind（下記 hostname: "127.0.0.1"）なので到達できるのは
// ローカルプロセスのみ — session-ctl と同じ操作者ローカルの信頼レベル。
// 検証（fail-closed な branch / issueNumber / selector 検査）はハンドラ側が担う。
export type HubWorkResponse =
  | { ok: true; threadId: string; queued: boolean; injected: string }
  | { ok: false; status: number; error: string };
export type HubWorkHandler = (
  body: Record<string, unknown>,
) => Promise<HubWorkResponse>;

// Issue #339: オーケストレーターの進捗・最終レポートを corp チャンネル**直下**へ
// 届ける経路。ローカルの CC セッション（session-ctl post-channel）が
// `POST /channel-post/:threadId` に {text} を投げると、bot.ts が登録した
// ハンドラが threadId のスレッドを解決し、その**親チャンネル**へ投稿する。
// 投稿先は構造的に「そのスレッドの親」に限定される（任意チャンネル投稿は不可）。
// loopback-only bind + ハンドラ未登録 503 の fail-closed は /hub-work と同じ
// 信頼境界。
export type ChannelPostResponse =
  | { ok: true; channelId: string; chunks: number }
  | { ok: false; status: number; error: string };
export type ChannelPostHandler = (
  threadId: string,
  text: string,
) => Promise<ChannelPostResponse>;

type ProgressCallback = (event: ProgressEvent) => void;
type LateResponseCallback = (event: LateResponseEvent) => void;
type AskUserCallback = (event: AskUserEvent) => void;
// Issue #78 (AC-4): supplies the read-only running-session snapshot served at
// `GET /health/sessions`. Registered by bot.ts so the relay server (a
// module-level singleton with no SessionManager reference) can answer health
// queries without importing the manager and creating a cycle.
type SessionsProvider = () => SessionHealthInfo[];

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

// /ask/:threadId default timeout. Issue #255: raised 120s → 300s. The incident
// dropped an AskUserQuestion after only 2 min unanswered, so a 会長 answering on
// mobile Discord lost the question. INVARIANT: the curl `--max-time` in
// hooks/ask-user-relay.sh MUST stay >= this / 1000 (otherwise curl gives up
// before the server, and the late reply is wasted). A test in
// relay-server.test.ts reads the hook and locks `--max-time*1000 >= DEFAULT`.
export const DEFAULT_ASK_TIMEOUT_MS = 300_000;
// Cap user-supplied timeouts so a malformed hook payload can't pin a request
// indefinitely. 10 minutes is well above any realistic Discord round-trip.
export const MAX_ASK_TIMEOUT_MS = 600_000;

/**
 * Issue #255: user-facing notice when the relay gives up waiting for the Stop
 * hook. The old text ("⚠️ Claude Code からの応答がタイムアウトしました。")
 * asserted the session had died. In practice the session is usually still
 * *alive* — a long dispatch turn merely exceeded the relay ceiling — and the
 * Stop hook's late POST is forwarded via the late-response path. Word it so the
 * user does not think the turn was lost. The `error` field stays
 * "Response timeout" for callers / tests that key on it.
 */
export const RELAY_TIMEOUT_USER_MESSAGE =
  "⏳ 制限時間内に応答が返りませんでした。セッションは稼働中の可能性があり、完了すると結果を追って転送します。しばらく待っても返らない場合は再送してください。";

let server: ReturnType<typeof Bun.serve> | null = null;
let relayPort = 0;
let progressCallback: ProgressCallback | null = null;
let lateResponseCallback: LateResponseCallback | null = null;
let askUserCallback: AskUserCallback | null = null;
let sessionsProvider: SessionsProvider | null = null;
let hubWorkHandler: HubWorkHandler | null = null;
let channelPostHandler: ChannelPostHandler | null = null;

/**
 * Well-known file that carries the relay server's ephemeral port (#320).
 * `Bun.serve({port: 0})` picks a random port, so an external local CLI
 * (session-ctl) needs a discovery point to reach `POST /hub-work`. Uses the
 * same runtime-dir scheme as manager.ts's relayUrlFilePath (XDG_RUNTIME_DIR
 * when present, else /tmp/claude-hub-supervisor-<USER>) so there is exactly one
 * runtime dir per user.
 */
export function relayPortFilePath(): string {
  const fromXdg = process.env.XDG_RUNTIME_DIR;
  const user = process.env.USER || "default";
  const runtimeDir = fromXdg
    ? `${fromXdg}/claude-hub-supervisor`
    : `/tmp/claude-hub-supervisor-${user}`;
  return `${runtimeDir}/relay-port`;
}

/**
 * Best-effort write of the port-discovery file (#320). Fail-soft: a filesystem
 * error must never take the relay server down — session-ctl start-hub-worker
 * simply reports "Supervisor 未起動" until the file appears.
 */
function writeRelayPortFile(port: number): void {
  const file = relayPortFilePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(port));
  } catch (err) {
    console.warn(`[relay-server] failed to write port file ${file}:`, err);
  }
}

/** Best-effort removal of the port-discovery file (stop path; ENOENT is fine). */
function removeRelayPortFile(): void {
  try {
    unlinkSync(relayPortFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[relay-server] failed to remove port file:`, err);
    }
  }
}

export function onProgress(callback: ProgressCallback): void {
  progressCallback = callback;
}

/**
 * Register the provider that backs `GET /health/sessions` (Issue #78, AC-4).
 * When no provider is registered the endpoint reports zero sessions rather than
 * failing, so a freshly-started supervisor (or a test that never wires it) still
 * answers 200 with an empty list.
 */
export function onSessionsQuery(provider: SessionsProvider): void {
  sessionsProvider = provider;
}

export function onLateResponse(callback: LateResponseCallback): void {
  lateResponseCallback = callback;
}

export function onAskUser(callback: AskUserCallback): void {
  askUserCallback = callback;
}

/**
 * Register the handler that backs `POST /hub-work` (#320, ADR-002 D5). When no
 * handler is registered the endpoint answers 503 (fail-closed) — a hub work
 * request can never silently no-op.
 */
export function onHubWork(handler: HubWorkHandler): void {
  hubWorkHandler = handler;
}

/**
 * Register the handler that backs `POST /channel-post/:threadId` (#339). When
 * no handler is registered the endpoint answers 503 (fail-closed) — a channel
 * post can never silently no-op.
 */
export function onChannelPost(handler: ChannelPostHandler): void {
  channelPostHandler = handler;
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
    // Bind loopback-only. Every consumer (manager.ts builds relayUrl as
    // http://localhost:<port>/..., hook scripts POST to that URL) reaches the
    // server via localhost, so 127.0.0.1 is sufficient. Bun.serve defaults to
    // 0.0.0.0, which would expose the relay endpoints — including the
    // /health/sessions session enumeration (Issue #78) — to the local network
    // (e.g. a LAN-reachable Raspberry Pi supervisor). Restrict by default.
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return new Response("ok", { status: 200 });
      }

      // Issue #78 (AC-4): read-only snapshot of running sessions so an E2E
      // harness can decisively verify the thread → tmux session mapping
      // (`claude-<threadId[..12]>`) without shelling into the host. Returns an
      // empty list (not an error) when no provider is registered.
      if (url.pathname === "/health/sessions" && req.method === "GET") {
        const sessions = sessionsProvider ? sessionsProvider() : [];
        return Response.json({
          count: sessions.length,
          max: MAX_SESSIONS,
          sessions,
        });
      }

      // Epic #316 Phase 3 (#320): claude-hub work セッション経路の起動口。
      // loopback-only なのでローカルの session-ctl / オーケストレーター CC
      // セッションだけが叩ける。ハンドラ未登録は 503（fail-closed）。
      if (url.pathname === "/hub-work" && req.method === "POST") {
        const handler = hubWorkHandler;
        if (!handler) {
          return Response.json(
            { error: "hub work handler not registered (Supervisor 起動中?)" },
            { status: 503 },
          );
        }
        let body: Record<string, unknown>;
        try {
          const parsed = (await req.json()) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
          }
          body = parsed as Record<string, unknown>;
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        try {
          const result = await handler(body);
          if (result.ok) {
            return Response.json(result, { status: 200 });
          }
          return Response.json(
            { error: result.error },
            { status: result.status },
          );
        } catch (err) {
          console.error("[relay-server] hubWorkHandler error:", err);
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      }

      // Issue #339: オーケストレーターの進捗・最終レポートをスレッドの親
      // チャンネル直下へ投稿する経路。loopback-only なのでローカルの
      // session-ctl / オーケストレーター CC セッションだけが叩ける。
      // ハンドラ未登録は 503（fail-closed、/hub-work と同型）。
      const channelPostMatch = url.pathname.match(/^\/channel-post\/(.+)$/);
      if (channelPostMatch && req.method === "POST") {
        const rawThreadId = channelPostMatch[1];
        if (!rawThreadId) {
          return Response.json({ error: "Invalid thread ID" }, { status: 400 });
        }
        // manager.ts / session-ctl と対称（encodeURIComponent で送られてくる）。
        let threadId: string;
        try {
          threadId = decodeURIComponent(rawThreadId);
        } catch {
          return Response.json(
            { error: "Invalid thread ID encoding" },
            { status: 400 },
          );
        }
        let body: Record<string, unknown>;
        try {
          const parsed = (await req.json()) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
          }
          body = parsed as Record<string, unknown>;
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) {
          return Response.json({ error: "text is required" }, { status: 400 });
        }
        const handler = channelPostHandler;
        if (!handler) {
          return Response.json(
            { error: "channel post handler not registered (Supervisor 起動中?)" },
            { status: 503 },
          );
        }
        try {
          const result = await handler(threadId, text);
          if (result.ok) {
            return Response.json(result, { status: 200 });
          }
          return Response.json(
            { error: result.error },
            { status: result.status },
          );
        } catch (err) {
          console.error("[relay-server] channelPostHandler error:", err);
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
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

        // Fast-fail when no subscriber is registered: pending asks would
        // otherwise sit in the map for the full timeoutMs (~120s) and block the
        // hook (review: coderabbitai on PR #142, comment 3179499098).
        const callback = askUserCallback;
        if (!callback) {
          return new Response(
            JSON.stringify({ error: "ask relay unavailable" }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          );
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
          try {
            callback({ threadId, question, options });
          } catch (err) {
            console.error("[relay-server] askUserCallback error:", err);
            const pending = pendingAsks.get(threadId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingAsks.delete(threadId);
              resolve({ status: 504 });
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
        // Issue #204: best-effort context size from the Stop hook. Accept only a
        // non-negative integer (the hook only ever emits one); anything else is
        // treated as "not reported".
        const contextTokens =
          typeof body.context_tokens === "number" &&
          Number.isInteger(body.context_tokens) &&
          body.context_tokens >= 0
            ? body.context_tokens
            : undefined;
        const chunks = formatForDiscord(text);

        const pending = pendingRequests.get(threadId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve({ text, chunks, claudeSessionId: sessionId, contextTokens });
          pendingRequests.delete(threadId);
          return new Response("ok", { status: 200 });
        }

        // Late-arriving Stop event (e.g., Monitor completion split the turn
        // into a second assistant message after the first already resolved).
        // Forward to Discord as a follow-up message so responses aren't lost.
        if (text && lateResponseCallback) {
          try {
            lateResponseCallback({ threadId, chunks, text, contextTokens });
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
  // #320: publish the ephemeral port so a local CLI (session-ctl) can discover
  // the /hub-work endpoint. Fail-soft — never blocks server startup.
  writeRelayPortFile(relayPort);
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
  sessionsProvider = null;
  hubWorkHandler = null;
  channelPostHandler = null;
  removeRelayPortFile();
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
      resolve({ text: "", chunks: [RELAY_TIMEOUT_USER_MESSAGE], error: "Response timeout" });
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
