import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { request } from "node:http";
import {
  startRelayServer,
  stopRelayServer,
  getRelayPort,
  onChannelPost,
  onHubWork,
} from "../../src/session/relay-server";

/**
 * Issue #541: relay サーバは 127.0.0.1 に bind しているが、ブラウザ経由の
 * CSRF（text/plain の単純リクエスト）と DNS rebinding（攻撃者ドメインの Host）
 * で外部の Web ページから届きうる。Host と Content-Type の検査を検証する。
 *
 * fetch は Host ヘッダを上書きできない実装があるため、node:http で送る。
 */

type RawResponse = { status: number; body: string };

function send(opts: {
  method: "GET" | "POST";
  path: string;
  host?: string;
  contentType?: string;
  body?: string;
}): Promise<RawResponse> {
  const port = getRelayPort();
  const headers: Record<string, string> = {
    Host: opts.host ?? `127.0.0.1:${port}`,
  };
  if (opts.contentType !== undefined) headers["Content-Type"] = opts.contentType;
  if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: opts.method, path: opts.path, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const THREAD = "111122223333444455";
const JSON_BODY = JSON.stringify({ text: "hello" });

describe("relay サーバの Host / Content-Type 検査 (#541)", () => {
  let channelPostCalls = 0;
  let hubWorkCalls = 0;

  beforeEach(() => {
    channelPostCalls = 0;
    hubWorkCalls = 0;
    startRelayServer();
    onChannelPost(async () => {
      channelPostCalls++;
      return { ok: true, channelId: "c", chunks: 1 };
    });
    onHubWork(async () => {
      hubWorkCalls++;
      return { ok: false, status: 422, error: "test handler" };
    });
  });

  afterEach(() => {
    stopRelayServer();
  });

  describe("Host 検査（DNS rebinding 対策）", () => {
    test("AC-1: 攻撃者ドメインの Host の GET /health/sessions は 403", async () => {
      const res = await send({
        method: "GET",
        path: "/health/sessions",
        host: `evil.example:${getRelayPort()}`,
      });
      expect(res.status).toBe(403);
      expect(res.body).not.toContain("sessions");
    });

    test("AC-1: 攻撃者ドメインの Host の POST /channel-post は 403 でハンドラを呼ばない", async () => {
      const res = await send({
        method: "POST",
        path: `/channel-post/${THREAD}`,
        host: "evil.example",
        contentType: "application/json",
        body: JSON_BODY,
      });
      expect(res.status).toBe(403);
      expect(channelPostCalls).toBe(0);
    });

    test("AC-1: ポートが違う localhost の Host も 403", async () => {
      const res = await send({
        method: "GET",
        path: "/health",
        host: `localhost:${getRelayPort() + 1}`,
      });
      expect(res.status).toBe(403);
    });

    test("AC-3: localhost:<port> と 127.0.0.1:<port> の GET /health は 200", async () => {
      const port = getRelayPort();
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
        const res = await send({ method: "GET", path: "/health", host });
        expect(res.status).toBe(200);
      }
    });
  });

  describe("Content-Type 検査（ブラウザ経由の CSRF 対策）", () => {
    test("AC-2: text/plain の POST /channel-post は 415 でハンドラを呼ばない", async () => {
      const res = await send({
        method: "POST",
        path: `/channel-post/${THREAD}`,
        contentType: "text/plain;charset=UTF-8",
        body: JSON_BODY,
      });
      expect(res.status).toBe(415);
      expect(channelPostCalls).toBe(0);
    });

    test("AC-2: Content-Type なしの POST /hub-work は 415 でハンドラを呼ばない", async () => {
      const res = await send({
        method: "POST",
        path: "/hub-work",
        body: JSON.stringify({ branch: "b", issueNumber: 1 }),
      });
      expect(res.status).toBe(415);
      expect(hubWorkCalls).toBe(0);
    });

    test("AC-2: form 送信相当（application/x-www-form-urlencoded）の POST /relay は 415", async () => {
      const res = await send({
        method: "POST",
        path: `/relay/${THREAD}`,
        contentType: "application/x-www-form-urlencoded",
        body: JSON_BODY,
      });
      expect(res.status).toBe(415);
    });

    test("AC-3: application/json（charset 付き・大文字混在も可）の POST はハンドラに届く", async () => {
      const port = getRelayPort();
      const res1 = await send({
        method: "POST",
        path: `/channel-post/${THREAD}`,
        host: `localhost:${port}`,
        contentType: "application/json",
        body: JSON_BODY,
      });
      const res2 = await send({
        method: "POST",
        path: `/channel-post/${THREAD}`,
        contentType: "Application/JSON; charset=utf-8",
        body: JSON_BODY,
      });
      expect(res1.status).not.toBe(403);
      expect(res1.status).not.toBe(415);
      expect(res2.status).not.toBe(415);
      expect(channelPostCalls).toBe(2);
    });
  });
});
