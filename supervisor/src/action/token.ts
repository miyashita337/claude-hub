import { createHmac, timingSafeEqual } from "crypto";

/**
 * Pushover one-tap action token — decode + verify (Issue #305, 層2/層3 boundary).
 *
 * This is the claude-hub (receiving) half of the token contract shared with
 * agent-base's `scripts/lib/action-token.sh` (the generating half, Issue #447).
 * The contract (正 = agent-base Issue #447 本文 / corp spec
 * `docs/superpowers/specs/2026-07-05-pushover-one-tap-action-design.md` §3):
 *
 *   payload = base64url(JSON{ v:1, action, target, iat, ttl, nonce })
 *   token   = payload + "." + base64url(HMAC-SHA256(payload, key))
 *
 * The HMAC is computed over the base64url-encoded payload STRING (the exact
 * bytes before the "."), keyed by the shared secret. Round-trip verified
 * against the real action-token.sh output (matching openssl HMAC bytes).
 *
 * This module is pure (no I/O): key resolution lives in ./key, nonce one-time
 * enforcement in ../infra/db, and the HTTP/execution pipeline in ./receiver.
 */

/** Decoded, shape-validated token payload. `v` is pinned to 1 by the contract. */
export interface ActionToken {
  v: 1;
  /** Action identifier — checked against the receiver allowlist before execution. */
  action: string;
  /** Action target; for `compact` this is the session worktree absolute path. */
  target: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Time-to-live, seconds (> 0). Token is expired once `now > iat + ttl`. */
  ttl: number;
  /** One-time nonce (hex); the receiver records used nonces to block replay. */
  nonce: string;
}

/**
 * Result of {@link parseToken}. On success the raw `payload`/`sig` substrings are
 * returned alongside the decoded token so the caller can verify the signature
 * against the exact bytes the HMAC was computed over (never a re-encoding).
 */
export type ParseResult =
  | { ok: true; token: ActionToken; payload: string; sig: string }
  | { ok: false; reason: string };

/**
 * Upper bound on the accepted token length. The sender caps the Pushover `url`
 * parameter at 512 chars (spec §3); 4096 is a generous ceiling that still
 * rejects absurd input before any base64/JSON work.
 */
const MAX_TOKEN_LENGTH = 4096;

/**
 * Decode a base64url string to bytes. Mirrors action-token.sh's `_action_token_b64url`
 * inverse: restore the standard alphabet (`-_` → `+/`) and re-pad to a multiple
 * of 4 before a standard base64 decode. Implemented explicitly (rather than
 * Buffer's "base64url") so the transform is identical to the bash contract and
 * independent of runtime base64url support.
 */
export function base64urlToBuffer(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = b64.length % 4;
  const pad = remainder === 0 ? "" : "=".repeat(4 - remainder);
  return Buffer.from(b64 + pad, "base64");
}

/** Encode bytes as base64url (padding stripped). Used only for diagnostics/tests. */
export function bufferToBase64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Split a token, base64url-decode the payload, and validate its shape. Does NOT
 * verify the signature or expiry — that is {@link verifySignature} /
 * {@link isExpired}, kept separate so the receiver pipeline runs them in the
 * contract's order (signature → TTL). Every rejection carries a short,
 * identifier-free `reason` for logging.
 */
export function parseToken(raw: string): ParseResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (raw.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  // Exactly one "." separating payload and signature. A leading/trailing dot or
  // a second dot means the token is not in `<payload>.<sig>` form.
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) {
    return { ok: false, reason: "format" };
  }
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (sig.includes(".")) {
    return { ok: false, reason: "format" };
  }

  let json: string;
  try {
    json = base64urlToBuffer(payload).toString("utf8");
  } catch {
    return { ok: false, reason: "base64" };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, reason: "not_object" };
  }

  const rec = obj as Record<string, unknown>;
  if (rec.v !== 1) return { ok: false, reason: "version" };
  if (typeof rec.action !== "string" || rec.action.length === 0) {
    return { ok: false, reason: "action" };
  }
  if (typeof rec.target !== "string" || rec.target.length === 0) {
    return { ok: false, reason: "target" };
  }
  if (typeof rec.iat !== "number" || !Number.isInteger(rec.iat)) {
    return { ok: false, reason: "iat" };
  }
  if (typeof rec.ttl !== "number" || !Number.isInteger(rec.ttl) || rec.ttl <= 0) {
    return { ok: false, reason: "ttl" };
  }
  if (typeof rec.nonce !== "string" || rec.nonce.length === 0) {
    return { ok: false, reason: "nonce" };
  }

  return {
    ok: true,
    payload,
    sig,
    token: {
      v: 1,
      action: rec.action,
      target: rec.target,
      iat: rec.iat,
      ttl: rec.ttl,
      nonce: rec.nonce,
    },
  };
}

/**
 * Constant-time verify that `sig` (base64url) is HMAC-SHA256(payload, key).
 * Returns false on any length mismatch or malformed signature rather than
 * throwing, so a crafted token can never surface as a 500. The comparison is
 * `timingSafeEqual` over the raw digest bytes to avoid leaking via early-exit.
 */
export function verifySignature(payload: string, sig: string, key: string): boolean {
  if (!key) return false;
  const expected = createHmac("sha256", key).update(payload).digest();
  let actual: Buffer;
  try {
    actual = base64urlToBuffer(sig);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * True once the token's lifetime has elapsed. `nowSeconds` is injected (epoch
 * seconds) so the receiver and tests share one clock. A token whose `iat` is in
 * the future is not treated as expired here (only lifetime elapse matters);
 * such tokens require the shared key to forge, which is the trust boundary.
 */
export function isExpired(token: ActionToken, nowSeconds: number): boolean {
  return nowSeconds > token.iat + token.ttl;
}
