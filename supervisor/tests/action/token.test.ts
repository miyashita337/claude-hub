import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, resolve } from "path";
import {
  parseToken,
  verifySignature,
  isExpired,
  base64urlToBuffer,
  bufferToBase64url,
} from "../../src/action/token";

/**
 * Token contract tests (Issue #305). The signing side is agent-base's
 * scripts/lib/action-token.sh (openssl HMAC). These tests generate tokens with
 * the SAME openssl pipeline (inline, CI-portable) and verify them in TS to lock
 * the cross-language contract, plus a best-effort round-trip against the real
 * action-token.sh source when it is reachable from origin/main.
 */

// Every test here mints tokens by spawning bash + openssl (and the round-trip
// test also shells out to git twice), so the file is subprocess-bound rather
// than compute-bound. Spawn latency has a long tail: measuring the round-trip
// helper over 40 local samples gave min 1272ms / p50 2396ms / p90 4972ms /
// max 30671ms, i.e. p90 sits right on bun's 5000ms default. That made
// unrelated tests time out at ~1 run in 25 with nothing else running
// (Issue #401 AC-1 surfaced it in `isExpired` and in the round-trip test).
// Raise the budget for the file; no assertion or timing expectation changes.
setDefaultTimeout(60_000);

const KEY = "test-shared-key-abc123";

// Inline generator byte-for-byte mirroring action-token.sh's algorithm:
//   payload = base64url(JSON{v,action,target,iat,ttl,nonce})
//   sig     = base64url(HMAC-SHA256(payload, key))
// `iat` is a parameter so expiry can be exercised deterministically.
const GEN_SCRIPT = `
set -euo pipefail
action="$1"; target="$2"; ttl="$3"; iat="$4"
nonce=$(openssl rand -hex 16)
json=$(printf '{"v":1,"action":"%s","target":"%s","iat":%s,"ttl":%s,"nonce":"%s"}' "$action" "$target" "$iat" "$ttl" "$nonce")
payload=$(printf '%s' "$json" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
sig=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$PUSHOVER_ACTION_HMAC_KEY" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
printf '%s.%s' "$payload" "$sig"
`;

function genToken(
  action: string,
  target: string,
  opts: { ttl?: number; iat?: number; key?: string } = {}
): string {
  const ttl = opts.ttl ?? 1800;
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  return execFileSync(
    "bash",
    ["-c", GEN_SCRIPT, "bash", action, target, String(ttl), String(iat)],
    {
      env: { ...process.env, PUSHOVER_ACTION_HMAC_KEY: opts.key ?? KEY },
      encoding: "utf8",
    }
  );
}

/**
 * Generate a token with the REAL agent-base action-token.sh, extracted from
 * origin/main into a temp dir alongside its keychain-get.sh dependency. Returns
 * null when agent-base / git is unreachable (e.g. CI) so the caller can skip.
 */
function genTokenViaRealScript(action: string, target: string): string | null {
  try {
    const agentBase = resolve(homedir(), "agent-base");
    if (!existsSync(agentBase)) return null;
    const lib = mkdtempSync(join(tmpdir(), "action-token-lib-"));
    for (const f of ["action-token.sh", "keychain-get.sh"]) {
      const content = execFileSync(
        "git",
        ["-C", agentBase, "show", `origin/main:scripts/lib/${f}`],
        { encoding: "utf8" }
      );
      writeFileSync(join(lib, f), content);
    }
    return execFileSync(
      "bash",
      [join(lib, "action-token.sh"), action, target, "1800"],
      {
        env: {
          ...process.env,
          PUSHOVER_ACTION_HMAC_KEY: KEY,
          KEYCHAIN_GET_SKIP_KEYCHAIN: "1",
          KEYCHAIN_GET_ENV_FILE: "/nonexistent",
        },
        encoding: "utf8",
      }
    ).trim();
  } catch {
    return null;
  }
}

describe("action/token base64url", () => {
  test("encode/decode round-trips arbitrary bytes", () => {
    const s = "こんにちは/世界+foo?=";
    const encoded = bufferToBase64url(Buffer.from(s, "utf8"));
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(base64urlToBuffer(encoded).toString("utf8")).toBe(s);
  });
});

describe("action/token parseToken", () => {
  test("valid token decodes to the expected shape", () => {
    const token = genToken("compact", "/Users/x/wt/issue-441", { ttl: 1800 });
    const parsed = parseToken(token);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.token.v).toBe(1);
    expect(parsed.token.action).toBe("compact");
    expect(parsed.token.target).toBe("/Users/x/wt/issue-441");
    expect(parsed.token.ttl).toBe(1800);
    expect(parsed.token.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  test("rejects malformed input (empty / no dot / bad base64 / bad json)", () => {
    expect(parseToken("").ok).toBe(false);
    expect(parseToken("nodothere").ok).toBe(false);
    expect(parseToken(".sig").ok).toBe(false);
    expect(parseToken("payload.").ok).toBe(false);
    expect(parseToken("a.b.c").ok).toBe(false);
    // payload is valid base64url but not JSON.
    const notJson = `${bufferToBase64url(Buffer.from("not json"))}.sig`;
    expect(parseToken(notJson).ok).toBe(false);
  });

  test("rejects wrong version and missing/invalid fields", () => {
    const mk = (obj: unknown) => `${bufferToBase64url(Buffer.from(JSON.stringify(obj)))}.sig`;
    const base = { v: 1, action: "compact", target: "/x", iat: 1000, ttl: 60, nonce: "n" };
    expect(parseToken(mk({ ...base, v: 2 })).ok).toBe(false);
    expect(parseToken(mk({ ...base, action: "" })).ok).toBe(false);
    expect(parseToken(mk({ ...base, target: "" })).ok).toBe(false);
    expect(parseToken(mk({ ...base, iat: 1.5 })).ok).toBe(false);
    expect(parseToken(mk({ ...base, ttl: 0 })).ok).toBe(false);
    expect(parseToken(mk({ ...base, ttl: -1 })).ok).toBe(false);
    expect(parseToken(mk({ ...base, nonce: "" })).ok).toBe(false);
    expect(parseToken(mk({ ...base, nonce: 123 })).ok).toBe(false);
  });
});

describe("action/token verifySignature (contract with openssl)", () => {
  test("valid openssl-generated token verifies with the shared key", () => {
    const token = genToken("compact", "/Users/x/wt/issue-441");
    const parsed = parseToken(token);
    if (!parsed.ok) throw new Error("parse failed");
    expect(verifySignature(parsed.payload, parsed.sig, KEY)).toBe(true);
  });

  test("wrong key fails verification", () => {
    const token = genToken("compact", "/Users/x/wt/issue-441");
    const parsed = parseToken(token);
    if (!parsed.ok) throw new Error("parse failed");
    expect(verifySignature(parsed.payload, parsed.sig, "wrong-key")).toBe(false);
  });

  test("tampered signature fails verification", () => {
    const token = genToken("compact", "/Users/x/wt/issue-441");
    const parsed = parseToken(token);
    if (!parsed.ok) throw new Error("parse failed");
    // Flip the FIRST character: all six of its bits map to real digest bits, so
    // any change alters the decoded bytes. Do NOT tamper the LAST character —
    // two of its bits are dropped on decode, so rewriting them leaves the bytes
    // identical and this assertion fails ~1/16 of the time (Issue #401). The
    // next test pins that decode behaviour so the reason stays visible.
    const badSig = (parsed.sig.startsWith("A") ? "B" : "A") + parsed.sig.slice(1);
    expect(badSig).not.toBe(parsed.sig);
    expect(verifySignature(parsed.payload, badSig, KEY)).toBe(false);
  });

  // Why the tamper above must not touch the last character (Issue #401): a
  // 32-byte HMAC is 43 base64url chars, and 42 of them already carry 252 bits.
  // The last char therefore holds only 4 significant bits plus 2 that decode
  // drops, so rewriting those 2 produces a DIFFERENT STRING for the SAME BYTES.
  // That is signature malleability (several encodings of one digest), not
  // forgery — an attacker still needs the correct 32 bytes, and the nonce is in
  // the payload — so verifySignature accepting it is correct, not a hole.
  test("non-canonical signature encoding decodes to the same bytes and still verifies", () => {
    const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const token = genToken("compact", "/Users/x/wt/issue-441");
    const parsed = parseToken(token);
    if (!parsed.ok) throw new Error("parse failed");
    expect(parsed.sig).toHaveLength(43);

    // A canonical 43rd char always lands on a 4-char boundary (low 2 bits zero),
    // so the three chars after it re-encode the very same 32 bytes.
    const lastIdx = B64URL.indexOf(parsed.sig.slice(-1));
    expect(lastIdx % 4).toBe(0);
    const nonCanonical = parsed.sig.slice(0, -1) + B64URL.charAt(lastIdx + 1);

    expect(nonCanonical).not.toBe(parsed.sig);
    expect(base64urlToBuffer(nonCanonical).equals(base64urlToBuffer(parsed.sig))).toBe(true);
    expect(verifySignature(parsed.payload, nonCanonical, KEY)).toBe(true);
  });

  test("tampered payload (target swapped) fails verification", () => {
    const token = genToken("compact", "/Users/x/wt/issue-441");
    const parsed = parseToken(token);
    if (!parsed.ok) throw new Error("parse failed");
    const forgedPayload = bufferToBase64url(
      Buffer.from(JSON.stringify({ ...parsed.token, target: "/etc/evil" }))
    );
    expect(verifySignature(forgedPayload, parsed.sig, KEY)).toBe(false);
  });

  test("garbage signature does not throw (returns false)", () => {
    const token = genToken("compact", "/x");
    const parsed = parseToken(token);
    if (!parsed.ok) throw new Error("parse failed");
    expect(verifySignature(parsed.payload, "!!!not-base64!!!", KEY)).toBe(false);
    expect(verifySignature(parsed.payload, parsed.sig, "")).toBe(false);
  });

  test("round-trip against the real agent-base action-token.sh (skips if unavailable)", () => {
    const token = genTokenViaRealScript("compact", "/Users/x/wt/issue-441");
    if (!token) {
      console.log(
        "[token.test] skip real action-token.sh round-trip (agent-base origin/main unreachable)"
      );
      return;
    }
    const parsed = parseToken(token);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.token.action).toBe("compact");
    expect(verifySignature(parsed.payload, parsed.sig, KEY)).toBe(true);
    expect(verifySignature(parsed.payload, parsed.sig, "wrong")).toBe(false);
  });
});

describe("action/token isExpired", () => {
  test("live token within ttl is not expired", () => {
    const iat = 1_000_000;
    const token = parseToken(genToken("compact", "/x", { ttl: 1800, iat }));
    if (!token.ok) throw new Error("parse failed");
    expect(isExpired(token.token, iat + 100)).toBe(false);
    expect(isExpired(token.token, iat + 1800)).toBe(false); // boundary: still valid
  });

  test("token past iat+ttl is expired", () => {
    const iat = 1_000_000;
    const token = parseToken(genToken("compact", "/x", { ttl: 1800, iat }));
    if (!token.ok) throw new Error("parse failed");
    expect(isExpired(token.token, iat + 1801)).toBe(true);
  });
});
