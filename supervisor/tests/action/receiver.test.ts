import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createHmac } from "crypto";
import { bufferToBase64url } from "../../src/action/token";
import type { EvaluateDeps, EvaluateResult } from "../../src/action/receiver";

// In-memory DB for the nonce-store tests (must be set before db.ts loads).
process.env.SUPERVISOR_DB_PATH = ":memory:";

const {
  evaluateAction,
  handleActRequest,
  renderResultHtml,
  resolveBindHost,
  startActionReceiver,
  stopActionReceiver,
  isActionReceiverRunning,
} = await import("../../src/action/receiver");
const { consumeActionNonce, getDb } = await import("../../src/infra/db");

const KEY = "receiver-test-key";
const NOW = 1_000_000; // fixed clock (epoch seconds) for deterministic expiry

function buildToken(obj: Record<string, unknown>, key = KEY): string {
  const payload = bufferToBase64url(Buffer.from(JSON.stringify(obj), "utf8"));
  const sig = bufferToBase64url(createHmac("sha256", key).update(payload).digest());
  return `${payload}.${sig}`;
}

let nonceCounter = 0;
function tokenFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    action: "compact",
    target: "/wt/a",
    iat: NOW,
    ttl: 1800,
    nonce: `n-${nonceCounter++}`,
    ...overrides,
  };
}

type SpyDeps = EvaluateDeps & {
  executed: { action: string; target: string }[];
  nonceCalls: string[];
};

function makeDeps(overrides: Partial<EvaluateDeps> = {}): SpyDeps {
  const executed: { action: string; target: string }[] = [];
  const nonceCalls: string[] = [];
  return {
    key: KEY,
    nowSeconds: NOW,
    isActionAllowed: (a) => a === "compact",
    consumeNonce: (nonce) => {
      nonceCalls.push(nonce);
      return true;
    },
    execute: async (action, target) => {
      executed.push({ action, target });
      return { ok: true, tmuxSession: "claude-x", sentText: "/compact intent" };
    },
    executed,
    nonceCalls,
    ...overrides,
  };
}

describe("action/receiver evaluateAction pipeline", () => {
  test("valid token executes and returns 200 sent", async () => {
    const deps = makeDeps();
    const result = await evaluateAction(buildToken(tokenFields()), deps);
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("sent");
    expect(deps.executed).toEqual([{ action: "compact", target: "/wt/a" }]);
  });

  test("signature mismatch → 401 and neither nonce nor execute is touched", async () => {
    const deps = makeDeps();
    const token = buildToken(tokenFields(), "attacker-key");
    const result = await evaluateAction(token, deps);
    expect(result.status).toBe(401);
    expect(result.outcome).toBe("bad_signature");
    expect(deps.nonceCalls).toHaveLength(0);
    expect(deps.executed).toHaveLength(0);
  });

  test("expired token → 410 before the nonce is consumed (order: sig→ttl→nonce)", async () => {
    const deps = makeDeps();
    // iat + ttl < NOW → expired.
    const token = buildToken(tokenFields({ iat: NOW - 10_000, ttl: 1800 }));
    const result = await evaluateAction(token, deps);
    expect(result.status).toBe(410);
    expect(result.outcome).toBe("expired");
    expect(deps.nonceCalls).toHaveLength(0);
    expect(deps.executed).toHaveLength(0);
  });

  test("allowlist-external action (valid signature) → 403, nonce not consumed", async () => {
    const deps = makeDeps();
    const token = buildToken(tokenFields({ action: "rm-rf" }));
    const result = await evaluateAction(token, deps);
    expect(result.status).toBe(403);
    expect(result.outcome).toBe("disallowed_action");
    expect(deps.nonceCalls).toHaveLength(0);
    expect(deps.executed).toHaveLength(0);
  });

  test("nonce reuse → first 200, second 409, execute runs only once", async () => {
    const used = new Set<string>();
    const executed: { action: string; target: string }[] = [];
    const deps = makeDeps({
      consumeNonce: (nonce) => {
        if (used.has(nonce)) return false;
        used.add(nonce);
        return true;
      },
      execute: async (action, target) => {
        executed.push({ action, target });
        return { ok: true, tmuxSession: "claude-x", sentText: "/compact intent" };
      },
    });
    const token = buildToken(tokenFields());
    const first = await evaluateAction(token, deps);
    const second = await evaluateAction(token, deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.outcome).toBe("nonce_reused");
    expect(executed).toHaveLength(1);
  });

  test("malformed token → 400", async () => {
    const result = await evaluateAction("not-a-real-token", makeDeps());
    expect(result.status).toBe(400);
    expect(result.outcome).toBe("malformed");
  });

  test("execute target_not_found → 404", async () => {
    const deps = makeDeps({
      execute: async () => ({ ok: false, reason: "target_not_found" }),
    });
    const result = await evaluateAction(buildToken(tokenFields()), deps);
    expect(result.status).toBe(404);
    expect(result.outcome).toBe("target_not_found");
  });

  test("execute send_failed → 502 with the cause", async () => {
    const deps = makeDeps({
      execute: async () => ({ ok: false, reason: "send_failed", detail: "boom" }),
    });
    const result = await evaluateAction(buildToken(tokenFields()), deps);
    expect(result.status).toBe(502);
    expect(result.outcome).toBe("send_failed");
    expect(result.detail).toBe("boom");
  });
});

describe("action/receiver handleActRequest (HTTP shape)", () => {
  test("valid /act?t= → 200 text/html success page", async () => {
    const token = buildToken(tokenFields());
    const url = new URL(`http://100.1.1.1:8317/act?t=${encodeURIComponent(token)}`);
    const res = await handleActRequest(url, makeDeps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("✅ /compact を送信しました");
  });

  test("missing token → 400 error page", async () => {
    const url = new URL("http://100.1.1.1:8317/act");
    const res = await handleActRequest(url, makeDeps());
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("リンクが不正");
  });
});

describe("action/receiver renderResultHtml", () => {
  test("is a self-contained mobile page and reflects no request input", () => {
    const result: EvaluateResult = {
      status: 200,
      outcome: "sent",
      action: "compact",
      target: "<script>alert(1)</script>",
    };
    const html = renderResultHtml(result);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("✅ /compact を送信しました");
    // The target is never reflected → no injection surface.
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("each outcome renders its own message", () => {
    expect(renderResultHtml({ status: 409, outcome: "nonce_reused" })).toContain("使用済み");
    expect(renderResultHtml({ status: 410, outcome: "expired" })).toContain("期限切れ");
    expect(renderResultHtml({ status: 403, outcome: "disallowed_action" })).toContain("許可されていません");
    expect(renderResultHtml({ status: 404, outcome: "target_not_found" })).toContain("見つかりません");
  });
});

describe("action/receiver resolveBindHost", () => {
  test("ACTION_RECEIVER_BIND override is used verbatim", async () => {
    const host = await resolveBindHost({ env: { ACTION_RECEIVER_BIND: "100.9.9.9" } });
    expect(host).toBe("100.9.9.9");
  });

  test("wildcard override is rejected (0.0.0.0 forbidden)", async () => {
    expect(await resolveBindHost({ env: { ACTION_RECEIVER_BIND: "0.0.0.0" } })).toBeNull();
    expect(await resolveBindHost({ env: { ACTION_RECEIVER_BIND: "::" } })).toBeNull();
  });

  test("falls back to the Tailscale IPv4", async () => {
    const host = await resolveBindHost({
      env: {},
      runTailscale: async () => "100.64.5.6\n",
    });
    expect(host).toBe("100.64.5.6");
  });

  test("no Tailscale IP → null (endpoint disabled, not a broader bind)", async () => {
    expect(await resolveBindHost({ env: {}, runTailscale: async () => null })).toBeNull();
  });

  test("Tailscale returning a wildcard / non-IP → null", async () => {
    expect(await resolveBindHost({ env: {}, runTailscale: async () => "0.0.0.0" })).toBeNull();
    expect(await resolveBindHost({ env: {}, runTailscale: async () => "not-an-ip" })).toBeNull();
    expect(await resolveBindHost({ env: {}, runTailscale: async () => "999.1.1.1" })).toBeNull();
  });
});

describe("action/receiver startActionReceiver lifecycle", () => {
  afterEach(() => stopActionReceiver());

  test("no key → not started, serve never called", async () => {
    let served = false;
    const res = await startActionReceiver({
      resolveKey: async () => null,
      resolveBind: async () => "100.1.1.1",
      serve: () => {
        served = true;
        return { stop: () => {} };
      },
    });
    expect(res).toEqual({ started: false, reason: "no_key" });
    expect(served).toBe(false);
    expect(isActionReceiverRunning()).toBe(false);
  });

  test("no bind IP → not started", async () => {
    const res = await startActionReceiver({
      resolveKey: async () => KEY,
      resolveBind: async () => null,
      serve: () => ({ stop: () => {} }),
    });
    expect(res).toEqual({ started: false, reason: "no_bind" });
    expect(isActionReceiverRunning()).toBe(false);
  });

  test("serve throwing → not started (bot unaffected), reason bind_failed", async () => {
    const res = await startActionReceiver({
      resolveKey: async () => KEY,
      resolveBind: async () => "100.1.1.1",
      serve: () => {
        throw new Error("EADDRINUSE");
      },
      buildEvaluateBase: () => ({
        isActionAllowed: (a) => a === "compact",
        consumeNonce: () => true,
        execute: async () => ({ ok: true, tmuxSession: "x", sentText: "y" }),
      }),
    });
    expect(res).toEqual({ started: false, reason: "bind_failed" });
    expect(isActionReceiverRunning()).toBe(false);
  });

  test("happy path binds, routes /act, /health, unknown, and stops cleanly", async () => {
    let capturedFetch: ((req: Request) => Promise<Response>) | undefined;
    let stopCalled = false;
    const res = await startActionReceiver({
      resolveKey: async () => KEY,
      resolveBind: async () => "100.1.1.1",
      port: 8317,
      serve: (o) => {
        capturedFetch = o.fetch;
        return {
          stop: () => {
            stopCalled = true;
          },
          port: o.port,
          hostname: o.hostname,
        };
      },
      buildEvaluateBase: (key) => {
        expect(key).toBe(KEY);
        return {
          isActionAllowed: (a) => a === "compact",
          consumeNonce: () => true,
          execute: async () => ({ ok: true, tmuxSession: "claude-x", sentText: "/compact x" }),
        };
      },
    });
    expect(res).toEqual({ started: true, hostname: "100.1.1.1", port: 8317 });
    expect(isActionReceiverRunning()).toBe(true);
    expect(capturedFetch).toBeDefined();

    // A second start is refused while one is live.
    const again = await startActionReceiver({ resolveKey: async () => KEY });
    expect(again).toEqual({ started: false, reason: "already_started" });

    // Route /act with a fresh, correctly-signed token (server uses real clock).
    const token = buildToken(tokenFields({ iat: Math.floor(Date.now() / 1000) }));
    const actRes = await capturedFetch!(
      new Request(`http://100.1.1.1:8317/act?t=${encodeURIComponent(token)}`)
    );
    expect(actRes.status).toBe(200);

    const health = await capturedFetch!(new Request("http://100.1.1.1:8317/health"));
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");

    const unknown = await capturedFetch!(new Request("http://100.1.1.1:8317/nope"));
    expect(unknown.status).toBe(404);

    stopActionReceiver();
    expect(stopCalled).toBe(true);
    expect(isActionReceiverRunning()).toBe(false);
  });
});

describe("infra/db consumeActionNonce (in-memory, one-time)", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM action_nonces");
  });

  test("first consume succeeds, replay of the same nonce fails", () => {
    expect(consumeActionNonce("nonce-A", "compact")).toBe(true);
    expect(consumeActionNonce("nonce-A", "compact")).toBe(false);
  });

  test("distinct nonces are independent", () => {
    expect(consumeActionNonce("nonce-B", "compact")).toBe(true);
    expect(consumeActionNonce("nonce-C", "compact")).toBe(true);
    expect(consumeActionNonce("nonce-B", "compact")).toBe(false);
  });

  test("end-to-end replay protection through evaluateAction using the real store", async () => {
    const token = buildToken(tokenFields({ nonce: "e2e-nonce-1" }));
    const deps = makeDeps({ consumeNonce: consumeActionNonce });
    const first = await evaluateAction(token, deps);
    const second = await evaluateAction(token, deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });
});
