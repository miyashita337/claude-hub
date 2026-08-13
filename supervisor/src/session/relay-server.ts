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
   * Issue #429: true when the failure is "the text never reached the pane"
   * (`buildSendFailureResult`), as opposed to "no response came back" (a relay
   * timeout / error turn). Both set {@link error}, but only the first means the
   * session never saw the message — the dispatch transport must report that as
   * a failed injection while leaving a slow-but-running job alone.
   */
  sendFailed?: boolean;
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
  /** Effective wait budget for this ask, so the thread notice can state the
   *  real deadline instead of a second hardcoded copy of it (Issue #416). */
  timeoutMs: number;
}

/**
 * Issue #416 (Journey AC #3): the ask expired with no reply. Without this the
 * expiry was silent on the Discord side — the hook simply fell back to the TUI
 * dialog and the thread still showed the question as if it were live. The
 * subscriber posts an explicit "期限切れ" notice so the user is never left
 * believing a question is still waiting for them.
 */
export interface AskExpiredEvent {
  threadId: string;
  question: string;
  timeoutMs: number;
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
type AskExpiredCallback = (event: AskExpiredEvent) => void;
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
  /** Echoed back on expiry so the thread notice can quote what went unanswered. */
  question: string;
  /** Effective wait budget, for the expiry notice. */
  timeoutMs: number;
}

const pendingRequests = new Map<string, PendingRequest>();
const pendingAsks = new Map<string, PendingAsk>();

// /ask/:threadId default timeout.
//
// Issue #255 raised it 120s → 300s; Issue #416 raises it 300s → 5 HOURS. The
// 5-minute window was not a wait, it was a formality: the 会長 reads the morning
// report on mobile hours after it is delivered, so a question was already
// expired by the time it was seen.
//
// INVARIANT: the curl `--max-time` in hooks/ask-user-relay.sh MUST stay
// >= this / 1000 (otherwise curl gives up before the server and the late reply
// is wasted) and <= MAX / 1000 (waiting past the server's hard cap can only
// hang the hook). relay-server.test.ts reads the hook and locks both bounds.
export const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 60 * 1000; // 5 hours

// Hard cap on the effective timeout, from either `ASK_TIMEOUT_MS` or a
// hook-supplied `timeout_ms`, so a malformed payload can't pin a request
// indefinitely. Deliberately NOT env-overridable: it is coupled to the curl
// budget in ask-user-relay.sh (a static literal in a shell script that the
// supervisor's env cannot reach), and raising one without the other silently
// re-creates the "curl gives up first" bug this pair of invariants exists to
// prevent. 6h leaves an hour of headroom above the default.
export const MAX_ASK_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * `Bun.serve({ idleTimeout })` in seconds; 0 disables it (Issue #416).
 *
 * Exported so a test can lock it. A behavioural test cannot: the request shape
 * /ask actually uses (POST with a body) is not affected by the default timeout
 * on Bun 1.3.11, so a 30s-hold test passes either way and would not notice this
 * option being dropped. See the measurement table at the `Bun.serve` call.
 */
export const RELAY_IDLE_TIMEOUT_SEC = 0;

/**
 * Resolve the effective ask timeout from `ASK_TIMEOUT_MS` (ms), falling back to
 * {@link DEFAULT_ASK_TIMEOUT_MS} for absent / non-numeric / non-positive values
 * and clamping to {@link MAX_ASK_TIMEOUT_MS}. Pure + exported so a unit test can
 * lock the default, the parse, and the clamp (mirrors `readRelayTimeoutMs`).
 */
export function readAskTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ASK_TIMEOUT_MS;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  const value =
    Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : DEFAULT_ASK_TIMEOUT_MS;
  return Math.min(value, MAX_ASK_TIMEOUT_MS);
}

/**
 * Human-readable form of a wait budget ("約 5 時間" / "約 30 分"), so the
 * Discord notices state the real deadline. Before #416 the wording was a
 * hardcoded "約 5 分" that had to be edited in lockstep with the constant —
 * exactly the two-copy drift that let a 300s server default be advertised while
 * the socket closed after 13s.
 */
export function formatAskWaitLabel(ms: number = readAskTimeoutMs()): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1) {
    const rounded = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return `約 ${rounded} 時間`;
  }
  return `約 ${Math.max(1, Math.round(ms / 60_000))} 分`;
}

/** Notice appended to the question posted in the thread (Issue #416). */
export function askWaitNotice(ms: number = readAskTimeoutMs()): string {
  return (
    `このスレッドへの次の返信がそのまま回答として送られます（${formatAskWaitLabel(ms)}待ちます）。\n` +
    "期限を過ぎると TUI ダイアログに戻りますが、選択肢が自動で選ばれることはありません（Issue #423）。"
  );
}

/** Longest question excerpt quoted back in the expiry notice. Keeps the notice
 *  well inside Discord's 2000-char limit however long the question was. */
const EXPIRED_QUESTION_EXCERPT = 300;

/**
 * Notice posted when the wait elapsed with no reply (Issue #416 AC-3).
 *
 * Quotes the question (PR #431 review, should-6). This notice can arrive five
 * hours after the question, by which point the thread has scrolled and "the
 * question expired" alone does not identify which one — the reader has to go
 * looking for it before they can decide whether to act.
 */
export function askExpiredNotice(
  ms: number = readAskTimeoutMs(),
  question?: string,
): string {
  const lines = [
    `⏰ 質問の回答待ちが期限切れになりました（${formatAskWaitLabel(ms)}無応答）。`,
  ];

  const trimmed = question?.trim();
  if (trimmed) {
    const excerpt =
      trimmed.length > EXPIRED_QUESTION_EXCERPT
        ? `${trimmed.slice(0, EXPIRED_QUESTION_EXCERPT)}…`
        : trimmed;
    // Blockquote every line: a multi-line question must not break out of the
    // quote and read as part of the notice's own instructions.
    lines.push("", ...excerpt.split("\n").map((line) => `> ${line}`));
  }

  lines.push(
    "",
    "自動では回答していません。回答するにはセッションに tmux attach するか、`/session status` で状態を確認してください。",
    // PR #431 review, should-3: say what the deadline now is. The reaper clock
    // is restarted when this fires (bot.ts touches activity), so the answer is
    // "the normal idle grace, counted from now" rather than a horizon that was
    // silently consumed by the wait itself.
    "このセッションの回収猶予はこの通知の時点から数え直されます。無音のままなら通常のアイドル回収の対象になります。",
  );

  return lines.join("\n");
}

/**
 * Issue #423: how long after an /ask ends the resulting TUI dialog is still
 * attributable to it. The PreToolUse hook opens the dialog only *after* its
 * curl returns, so "currently pending" is not enough to protect the fallback
 * dialog — the window covers the gap between the hook exiting and the watchdog's
 * next poll (5s) with generous slack. Once the watchdog declines a dialog it
 * latches, so this window only has to be long enough to catch the dialog once.
 */
export const ASK_FALLBACK_GRACE_MS = 60_000;

/** threadId → epoch ms of the last /ask activity (arrival or settlement). */
const askActivityAt = new Map<string, number>();

function markAskActivity(threadId: string): void {
  const now = Date.now();
  askActivityAt.set(threadId, now);
  // Prune while we're here: entries older than the window can never satisfy
  // hasRecentAsk again, and nothing else evicts them (a thread id is never
  // "closed" from this module's point of view).
  for (const [id, at] of askActivityAt) {
    if (now - at > ASK_FALLBACK_GRACE_MS) askActivityAt.delete(id);
  }
}

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
let askExpiredCallback: AskExpiredCallback | null = null;
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
 * Register the subscriber notified when a pending /ask expires unanswered
 * (Issue #416 AC-3). Optional by construction: with no subscriber the ask still
 * resolves 504 and the hook still falls back — only the Discord notice is lost.
 */
export function onAskExpired(callback: AskExpiredCallback): void {
  askExpiredCallback = callback;
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
  markAskActivity(threadId);
  pending.resolve({ status: 200, answer });
}

/**
 * Issue #370: whether a /ask/:threadId request is currently awaiting a user
 * reply for this thread. bot.ts consults this in messageCreate so the next
 * thread message resolves the pending ask instead of being relayed into tmux
 * (the session is blocked inside the PreToolUse hook and the TUI is not
 * accepting input).
 */
export function hasPendingAsk(threadId: string): boolean {
  return pendingAsks.has(threadId);
}

/**
 * Issue #423: true while an AskUserQuestion is in flight for this thread OR
 * ended within {@link ASK_FALLBACK_GRACE_MS}. The dialog watchdog uses it to
 * withhold auto-accept, because the TUI dialog the hook falls back to appears
 * *after* the ask settles — `hasPendingAsk` alone would be false exactly when
 * the dangerous dialog is on screen.
 */
export function hasRecentAsk(
  threadId: string,
  windowMs: number = ASK_FALLBACK_GRACE_MS,
): boolean {
  if (pendingAsks.has(threadId)) return true;
  const at = askActivityAt.get(threadId);
  // Exclusive bound. With `<=`, a window of 0 still matched for the remainder
  // of the millisecond the ask settled in — so "no grace window" depended on
  // how fast the caller ran (it failed in CI and passed locally). Exclusive
  // makes `windowMs: 0` mean exactly "only while pending"; at the production
  // 60s window the difference is one millisecond.
  return at !== undefined && Date.now() - at < windowMs;
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
  markAskActivity(threadId);
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
    // Issue #416: pin the idle timeout off. Bun defaults it to 10s and counts
    // "in-flight requests where your handler is still running but hasn't
    // written any bytes to the response yet" (bun.com/docs/api/http) — which
    // describes POST /ask exactly while it waits for the user. Its maximum is
    // 255s, so a multi-hour wait is only expressible as 0.
    //
    // Measured on Bun 1.3.11 before setting this (all against a real server,
    // handler holding 20s):
    //   - GET, body not read           → cut at ~12s (curl exit 52, fetch threw)
    //   - POST + JSON body read        → completed 200 at 20.5s, NOT cut
    // So today's production path (curl POST from ask-user-relay.sh) already
    // survived, and the "#416 measured 13s" note in the issue reproduced the
    // GET shape rather than /ask. The 5h wait therefore does NOT depend on this
    // line today — but it does depend on Bun continuing to treat a consumed
    // request body as activity, which is undocumented. Setting it explicitly
    // makes a 5h hold a property of our configuration instead of an
    // implementation detail we happen to benefit from.
    //
    // Safe because the server is loopback-only (hostname above): the
    // connections it holds open come from local hook scripts, not the network.
    idleTimeout: RELAY_IDLE_TIMEOUT_SEC,
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
            : readAskTimeoutMs();
        const timeoutMs = Math.min(requested, MAX_ASK_TIMEOUT_MS);

        // Issue #423: from here on a TUI AskUserQuestion dialog exists for this
        // session — either now (if the relay fails) or when this request
        // settles unanswered. Mark before any early return so even the 503
        // fast-fail path below protects the dialog it is about to leave behind.
        markAskActivity(threadId);

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
            markAskActivity(threadId);
            // Issue #416 AC-3: expiry must be visible in Discord. Best-effort
            // and isolated — a throwing subscriber must not stop the hook from
            // getting its 504 (which is what unblocks the session).
            const expired = askExpiredCallback;
            if (expired) {
              try {
                expired({ threadId, question, timeoutMs });
              } catch (err) {
                console.error("[relay-server] askExpiredCallback error:", err);
              }
            } else {
              console.warn(
                `[relay-server] ask expired for thread ${threadId} after ${timeoutMs}ms with no askExpired subscriber — the thread was not told`,
              );
            }
            resolve({ status: 504 });
          }, timeoutMs);
          pendingAsks.set(threadId, { resolve, timer, question, timeoutMs });

          // Notify subscribers AFTER the entry is registered so a synchronous
          // resolveAskUser call from the callback always finds the pending
          // request. Wrap in try/catch so a buggy callback can't leave the
          // request hanging.
          try {
            callback({ threadId, question, options, timeoutMs });
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
  askActivityAt.clear();

  server.stop(true);
  server = null;
  relayPort = 0;
  progressCallback = null;
  lateResponseCallback = null;
  askUserCallback = null;
  askExpiredCallback = null;
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
    // Issue #416: the relay ceiling (15 min by default, 60 min max) is now far
    // SHORTER than an ask can legitimately wait (5h). Firing here while a
    // question is on screen would tell the thread "応答が返りませんでした"
    // directly underneath a question the user is still deciding on, and would
    // tear down the dialog watchdog that #423 relies on to page instead of
    // pressing keys. A session parked inside the PreToolUse hook is not a lost
    // turn — it is blocked on the user by our own design — so re-arm instead.
    // Bounded: the ask itself is capped at MAX_ASK_TIMEOUT_MS, after which
    // hasPendingAsk goes false and the next cycle times out normally.
    const fire = () => {
      const entry = pendingRequests.get(threadId);
      // Superseded or cancelled while we slept: that path already resolved this
      // promise and owns the map entry. Do nothing rather than resolve twice.
      if (!entry || entry.resolve !== resolve) return;

      if (pendingAsks.has(threadId)) {
        entry.timer = setTimeout(fire, timeoutMs);
        return;
      }

      pendingRequests.delete(threadId);
      resolve({ text: "", chunks: [RELAY_TIMEOUT_USER_MESSAGE], error: "Response timeout" });
    };

    pendingRequests.set(threadId, { resolve, timer: setTimeout(fire, timeoutMs) });
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
