import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import {
  startRelayServer,
  stopRelayServer,
  getRelayPort,
  onHubWork,
  relayPortFilePath,
} from "../../src/session/relay-server";

/**
 * `POST /hub-work`（Epic #316 Phase 3 / #320, ADR-002 D5）と relay ポート
 * ファイルの追加分だけを検証する。既存 relay-server.test.ts には触れない
 * （既存テスト変更 0 件の BLOCKING 制約）。
 */

function hubWorkUrl(): string {
  return `http://127.0.0.1:${getRelayPort()}/hub-work`;
}

describe("POST /hub-work", () => {
  beforeEach(() => {
    startRelayServer();
  });

  afterEach(() => {
    stopRelayServer();
  });

  test("ハンドラ未登録は 503（fail-closed、黙って no-op しない）", async () => {
    const res = await fetch(hubWorkUrl(), {
      method: "POST",
      body: JSON.stringify({ branch: "b", issueNumber: 1 }),
    });
    expect(res.status).toBe(503);
  });

  test("不正 JSON は 400", async () => {
    onHubWork(async () => {
      throw new Error("should not be called");
    });
    const res = await fetch(hubWorkUrl(), { method: "POST", body: "{oops" });
    expect(res.status).toBe(400);
  });

  test("非オブジェクト JSON（配列）は 400", async () => {
    onHubWork(async () => {
      throw new Error("should not be called");
    });
    const res = await fetch(hubWorkUrl(), {
      method: "POST",
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  test("ok ハンドラ結果は 200 + JSON パススルー", async () => {
    let received: unknown = null;
    onHubWork(async (body) => {
      received = body;
      return { ok: true, threadId: "T1", queued: false, injected: "/pdca 320" };
    });
    const res = await fetch(hubWorkUrl(), {
      method: "POST",
      body: JSON.stringify({ branch: "feat-320", issueNumber: 320, selector: "pdca" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.threadId).toBe("T1");
    expect(json.injected).toBe("/pdca 320");
    expect(received).toEqual({
      branch: "feat-320",
      issueNumber: 320,
      selector: "pdca",
    });
  });

  test("ハンドラの ok:false は status/error をそのまま返す", async () => {
    onHubWork(async () => ({ ok: false, status: 400, error: "branch が不正" }));
    const res = await fetch(hubWorkUrl(), {
      method: "POST",
      body: JSON.stringify({ branch: "a;b", issueNumber: 1 }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toContain("branch");
  });

  test("ハンドラ throw は 500（unhandled で落ちない）", async () => {
    onHubWork(async () => {
      throw new Error("kaboom");
    });
    const res = await fetch(hubWorkUrl(), {
      method: "POST",
      body: JSON.stringify({ branch: "b", issueNumber: 1 }),
    });
    expect(res.status).toBe(500);
  });

  test("stopRelayServer でハンドラがリセットされる（再 start 後は 503）", async () => {
    onHubWork(async () => ({ ok: true, threadId: "T1", queued: false, injected: "/impl 1" }));
    stopRelayServer();
    startRelayServer();
    const res = await fetch(hubWorkUrl(), {
      method: "POST",
      body: JSON.stringify({ branch: "b", issueNumber: 1 }),
    });
    expect(res.status).toBe(503);
  });
});

describe("relay ポートファイル（session-ctl のポート発見点、#320）", () => {
  afterEach(() => {
    stopRelayServer();
  });

  test("start で実ポートが書かれ、stop で消える", () => {
    startRelayServer();
    const file = relayPortFilePath();
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(String(getRelayPort()));
    stopRelayServer();
    expect(existsSync(file)).toBe(false);
  });
});
