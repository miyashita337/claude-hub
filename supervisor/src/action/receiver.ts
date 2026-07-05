import { execFile } from "child_process";
import { promisify } from "util";
import { parseToken, verifySignature, isExpired } from "./token";
import {
  executeAction,
  resolveTmuxSessionForTarget,
  realTmuxPaneList,
  realpathOrResolve,
  isActionAllowed,
} from "./execute";
import type { ExecuteResult } from "./execute";
import { resolveHmacKey } from "./key";
import { getRunningSessions, consumeActionNonce } from "../infra/db";

const execFileAsync = promisify(execFile);

/**
 * Layer 3 — HTTP receiver for Pushover one-tap actions (Issue #305, spec §5).
 *
 * `GET /act?t=<token>` runs the fixed verification pipeline, executes the
 * layer-4 adapter on success, and returns a phone-friendly HTML page either way.
 * The server binds ONLY to the Tailscale interface IP (never 0.0.0.0), so it is
 * unreachable outside the tailnet — the first of the spec's three defences
 * (network / token / allowlist). It co-habits the supervisor process; a startup
 * failure disables the endpoint with a WARN and never takes the bot down.
 *
 * The pipeline ({@link evaluateAction}) and HTML rendering are pure and injected
 * with their effects, so the whole request path is unit-testable without binding
 * a port, a real DB, or tmux. Production wiring is dynamic-imported inside
 * {@link startActionReceiver} to keep this module's static imports light.
 */

const DEFAULT_ACTION_RECEIVER_PORT = 8317;

/** Non-secret verification effects, minus the per-request `key`/`nowSeconds`. */
export interface EvaluateBase {
  isActionAllowed: (action: string) => boolean;
  /** Atomically record a nonce; false = already used (replay). */
  consumeNonce: (nonce: string, action: string) => boolean;
  execute: (action: string, target: string) => Promise<ExecuteResult>;
}

export interface EvaluateDeps extends EvaluateBase {
  key: string;
  /** Current time, epoch seconds (injected so tests control expiry). */
  nowSeconds: number;
}

export type ReceiverOutcome =
  | "sent"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "disallowed_action"
  | "nonce_reused"
  | "target_not_found"
  | "send_failed";

export interface EvaluateResult {
  status: number;
  outcome: ReceiverOutcome;
  action?: string;
  target?: string;
  /** Short, identifier-free diagnostic for logs (never the token/key). */
  detail?: string;
}

/**
 * The verification + execution pipeline. Order is fixed by the contract and by
 * cost (spec §5): signature → TTL → allowlist → nonce → execute. A token that
 * fails signature, TTL, or the allowlist is rejected BEFORE the nonce is
 * consumed, so only a fully-valid tap burns its one-time nonce. The nonce is
 * consumed atomically immediately before execute; a subsequent execute failure
 * therefore does not reopen the URL to replay (fail-closed) — the user retries
 * from a fresh notification.
 */
export async function evaluateAction(
  rawToken: string,
  deps: EvaluateDeps
): Promise<EvaluateResult> {
  const parsed = parseToken(rawToken);
  if (!parsed.ok) {
    return { status: 400, outcome: "malformed", detail: parsed.reason };
  }
  const { token, payload, sig } = parsed;

  if (!verifySignature(payload, sig, deps.key)) {
    return { status: 401, outcome: "bad_signature", action: token.action };
  }
  if (isExpired(token, deps.nowSeconds)) {
    return { status: 410, outcome: "expired", action: token.action };
  }
  if (!deps.isActionAllowed(token.action)) {
    return { status: 403, outcome: "disallowed_action", action: token.action };
  }
  if (!deps.consumeNonce(token.nonce, token.action)) {
    return { status: 409, outcome: "nonce_reused", action: token.action };
  }

  const result = await deps.execute(token.action, token.target);
  if (result.ok) {
    return { status: 200, outcome: "sent", action: token.action, target: token.target };
  }
  switch (result.reason) {
    case "target_not_found":
      return {
        status: 404,
        outcome: "target_not_found",
        action: token.action,
        target: token.target,
      };
    case "disallowed_action":
      return { status: 403, outcome: "disallowed_action", action: token.action };
    case "send_failed":
      return {
        status: 502,
        outcome: "send_failed",
        action: token.action,
        detail: result.detail,
      };
    default:
      return { status: 500, outcome: "send_failed", action: token.action };
  }
}

/** Fixed, non-reflective user message per outcome (no token/target echoed → no XSS). */
function messageFor(outcome: ReceiverOutcome): { title: string; body: string } {
  switch (outcome) {
    case "sent":
      return { title: "送信しました", body: "✅ /compact を送信しました" };
    case "malformed":
      return { title: "無効なリンク", body: "❌ リンクが不正です" };
    case "bad_signature":
      return { title: "署名エラー", body: "❌ 署名を確認できませんでした" };
    case "expired":
      return { title: "期限切れ", body: "⌛ リンクの有効期限が切れています" };
    case "disallowed_action":
      return { title: "未許可アクション", body: "🚫 このアクションは許可されていません" };
    case "nonce_reused":
      return { title: "使用済み", body: "♻️ このリンクは使用済みです" };
    case "target_not_found":
      return { title: "対象が見つかりません", body: "🔍 対象セッションが見つかりませんでした" };
    case "send_failed":
      return { title: "送信失敗", body: "⚠️ 送信に失敗しました" };
  }
}

/**
 * Render the phone-facing result page. Self-contained, no external assets, with
 * a viewport meta so it reads well on a locked-down mobile browser. Only fixed
 * strings from {@link messageFor} are interpolated — the token, target, and any
 * request input are never reflected, so there is no injection surface.
 */
export function renderResultHtml(result: EvaluateResult): string {
  const { title, body } = messageFor(result.outcome);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; background: #0d1117; color: #e6edf3; }
  .card { text-align: center; padding: 2rem 1.5rem; }
  .body { font-size: 1.5rem; line-height: 1.5; }
</style>
</head>
<body>
<div class="card"><div class="body">${body}</div></div>
</body>
</html>`;
}

function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * HTTP-shaped handler for `GET /act`: extract `t`, run {@link evaluateAction},
 * log the outcome (spec §12 observability — every request, with reason, never
 * the token), and render the result page with the mapped status. Exported so a
 * test can exercise the full request path via a URL without binding a port.
 */
export async function handleActRequest(
  url: URL,
  deps: EvaluateDeps
): Promise<Response> {
  const token = url.searchParams.get("t");
  if (!token) {
    console.warn("[action-receiver] request rejected: missing token");
    return htmlResponse(400, renderResultHtml({ status: 400, outcome: "malformed" }));
  }
  const result = await evaluateAction(token, deps);
  const targetNote = result.target ? ` target=${result.target}` : "";
  const detailNote = result.detail ? ` detail=${result.detail}` : "";
  const line =
    `[action-receiver] outcome=${result.outcome} status=${result.status}` +
    ` action=${result.action ?? "-"}${targetNote}${detailNote}`;
  if (result.outcome === "sent") console.log(line);
  else console.warn(line);
  return htmlResponse(result.status, renderResultHtml(result));
}

export interface BindResolveDeps {
  env?: NodeJS.ProcessEnv;
  /** Returns `tailscale ip -4` stdout, or null when unavailable. Injectable for tests. */
  runTailscale?: () => Promise<string | null>;
}

/** Reject wildcard/any-address binds — the spec forbids exposing beyond the tailnet. */
function isWildcardBind(host: string): boolean {
  return host === "" || host === "0.0.0.0" || host === "::" || host === "*";
}

function isPlausibleIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255;
  });
}

/**
 * Resolve the interface IP to bind to. `ACTION_RECEIVER_BIND` overrides (still
 * rejecting wildcard addresses); otherwise the node's Tailscale IPv4 from
 * `tailscale ip -4` (PATH binary, then the macOS app bundle). Returns null when
 * no tailnet IP can be found, so the caller disables the endpoint with a WARN
 * instead of falling back to a broader bind.
 */
export async function resolveBindHost(deps: BindResolveDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const override = env.ACTION_RECEIVER_BIND?.trim();
  if (override) {
    if (isWildcardBind(override)) {
      console.warn(
        `[action-receiver] ACTION_RECEIVER_BIND='${override}' is a wildcard bind (forbidden) — endpoint disabled`
      );
      return null;
    }
    return override;
  }

  const run = deps.runTailscale ?? defaultRunTailscale;
  const ip = (await run())?.trim();
  if (!ip) return null;
  if (isWildcardBind(ip) || !isPlausibleIpv4(ip)) {
    console.warn(`[action-receiver] tailscale returned an unusable bind address '${ip}' — endpoint disabled`);
    return null;
  }
  return ip;
}

async function defaultRunTailscale(): Promise<string | null> {
  const candidates = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ["ip", "-4"], { timeout: 3000 });
      const first = stdout
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .find(Boolean);
      if (first) return first;
    } catch {
      // Try the next candidate binary.
    }
  }
  return null;
}

function readPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACTION_RECEIVER_PORT;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_ACTION_RECEIVER_PORT;
}

/** Minimal server handle — the subset of Bun.serve's return we use. */
interface ServerHandle {
  stop: (closeActiveConnections?: boolean) => void;
  port?: number;
  hostname?: string;
}

let server: ServerHandle | null = null;

export interface StartActionReceiverOptions {
  resolveKey?: () => Promise<string | null>;
  resolveBind?: () => Promise<string | null>;
  port?: number;
  /** Injectable server factory (defaults to Bun.serve). */
  serve?: (options: {
    hostname: string;
    port: number;
    fetch: (req: Request) => Promise<Response>;
  }) => ServerHandle;
  /** Injectable production effects builder (defaults to the real DB/tmux wiring). */
  buildEvaluateBase?: (key: string) => EvaluateBase | Promise<EvaluateBase>;
}

export type StartResult =
  | { started: true; hostname: string; port: number }
  | { started: false; reason: string };

/**
 * Start the receiver, resolving the key and bind IP first. Never throws: any
 * failure (missing key, no tailnet IP, bind error) returns `{ started: false }`
 * with a reason and a WARN, leaving the supervisor/bot fully operational.
 */
export async function startActionReceiver(
  opts: StartActionReceiverOptions = {}
): Promise<StartResult> {
  if (server) return { started: false, reason: "already_started" };

  let key: string | null;
  try {
    key = await (opts.resolveKey ?? resolveHmacKey)();
  } catch (err) {
    console.warn("[action-receiver] key resolution failed — endpoint disabled:", err);
    return { started: false, reason: "key_error" };
  }
  if (!key) {
    console.warn(
      "[action-receiver] disabled: PUSHOVER_ACTION_HMAC_KEY not set (env / Keychain). One-tap actions are off."
    );
    return { started: false, reason: "no_key" };
  }

  let host: string | null;
  try {
    host = await (opts.resolveBind ?? resolveBindHost)();
  } catch (err) {
    console.warn("[action-receiver] bind resolution failed — endpoint disabled:", err);
    return { started: false, reason: "bind_error" };
  }
  if (!host) {
    console.warn(
      "[action-receiver] disabled: could not resolve a Tailscale bind IP (set ACTION_RECEIVER_BIND to override)."
    );
    return { started: false, reason: "no_bind" };
  }

  const port = opts.port ?? readPort();
  const base = await (opts.buildEvaluateBase
    ? opts.buildEvaluateBase(key)
    : buildProductionEvaluateBase());

  const boundKey = key;
  const fetchHandler = async (req: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return htmlResponse(400, renderResultHtml({ status: 400, outcome: "malformed" }));
    }
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/act" && req.method === "GET") {
      try {
        return await handleActRequest(url, {
          ...base,
          key: boundKey,
          nowSeconds: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        // DB ロックや一時的な I/O エラー等の未捕捉例外でサーバを落とさず、
        // スマホ側にも 500 の結果画面を返す（CodeRabbit medium 指摘対応）
        console.error("[action-receiver] Unhandled error in handleActRequest:", err);
        return htmlResponse(500, renderResultHtml({ status: 500, outcome: "send_failed" }));
      }
    }
    return new Response("Not found", { status: 404 });
  };

  const serveImpl = opts.serve ?? ((o) => Bun.serve(o) as unknown as ServerHandle);
  try {
    const s = serveImpl({ hostname: host, port, fetch: fetchHandler });
    server = s;
    const boundPort = s.port ?? port;
    console.log(
      `[action-receiver] listening on http://${host}:${boundPort}/act (Tailscale-only bind)`
    );
    return { started: true, hostname: host, port: boundPort };
  } catch (err) {
    console.warn(
      `[action-receiver] failed to bind ${host}:${port}: ${
        err instanceof Error ? err.message : String(err)
      } — endpoint disabled (bot unaffected)`
    );
    server = null;
    return { started: false, reason: "bind_failed" };
  }
}

/**
 * Build the production verification effects. The heavy session modules
 * (manager, relay) are dynamic-imported here so importing this file for the
 * pure pipeline (tests) does not pull the whole session tree.
 */
async function buildProductionEvaluateBase(): Promise<EvaluateBase> {
  const { SessionManager } = await import("../session/manager");
  const { sendToPane } = await import("../session/relay");

  const resolveSession = (target: string) =>
    resolveTmuxSessionForTarget(target, {
      runningSessions: () =>
        getRunningSessions()
          .filter((r): r is typeof r & { thread_id: string } =>
            typeof r.thread_id === "string" && r.thread_id.length > 0
          )
          .map((r) => ({
            tmuxSession: SessionManager.tmuxSessionNameFor(r.thread_id),
            projectDir: r.project_dir,
          })),
      listTmuxPanes: realTmuxPaneList,
      realpath: realpathOrResolve,
    });

  return {
    isActionAllowed,
    consumeNonce: consumeActionNonce,
    execute: (action, target) =>
      executeAction(action, target, { resolveSession, send: sendToPane }),
  };
}

/** Stop the receiver (shutdown path). Safe to call when never started. */
export function stopActionReceiver(): void {
  if (!server) return;
  try {
    server.stop(true);
  } catch (err) {
    console.warn("[action-receiver] error stopping server:", err);
  }
  server = null;
}

/** Test-only: whether the receiver is currently running. */
export function isActionReceiverRunning(): boolean {
  return server !== null;
}
