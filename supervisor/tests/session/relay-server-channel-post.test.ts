import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  startRelayServer,
  stopRelayServer,
  getRelayPort,
  onChannelPost,
} from "../../src/session/relay-server";

/**
 * `POST /channel-post/:threadId`（Issue #339）の追加分だけを検証する。
 * 既存 relay-server.test.ts / relay-server-hub-work.test.ts には触れない
 * （既存テスト変更 0 件の BLOCKING 制約、AC-3）。
 */

function channelPostUrl(threadId: string): string {
  return `http://127.0.0.1:${getRelayPort()}/channel-post/${encodeURIComponent(threadId)}`;
}

describe("POST /channel-post/:threadId", () => {
  beforeEach(() => {
    startRelayServer();
  });

  afterEach(() => {
    stopRelayServer();
  });

  test("ハンドラ未登録は 503（fail-closed、黙って no-op しない）", async () => {
    const res = await fetch(channelPostUrl("111122223333444455"), {
      method: "POST",
      body: JSON.stringify({ text: "progress" }),
    });
    expect(res.status).toBe(503);
  });

  test("不正 JSON は 400", async () => {
    onChannelPost(async () => {
      throw new Error("should not be called");
    });
    const res = await fetch(channelPostUrl("111122223333444455"), {
      method: "POST",
      body: "{oops",
    });
    expect(res.status).toBe(400);
  });

  test("text 欠落 / 空白のみは 400", async () => {
    onChannelPost(async () => {
      throw new Error("should not be called");
    });
    for (const body of [{}, { text: "   " }, { text: 42 }]) {
      const res = await fetch(channelPostUrl("111122223333444455"), {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  test("threadId の不正エンコーディングは 400", async () => {
    onChannelPost(async () => {
      throw new Error("should not be called");
    });
    const res = await fetch(
      `http://127.0.0.1:${getRelayPort()}/channel-post/%ZZ`,
      { method: "POST", body: JSON.stringify({ text: "t" }) },
    );
    expect(res.status).toBe(400);
  });

  test("ok ハンドラ結果は 200 + JSON パススルー（threadId はデコード済みで渡る）", async () => {
    let received: unknown = null;
    onChannelPost(async (threadId, text) => {
      received = { threadId, text };
      return { ok: true, channelId: "C1", chunks: 2 };
    });
    const res = await fetch(channelPostUrl("111122223333444455"), {
      method: "POST",
      body: JSON.stringify({ text: "## 進捗\n```mermaid\ngraph TD\n```" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.channelId).toBe("C1");
    expect(json.chunks).toBe(2);
    expect(received).toEqual({
      threadId: "111122223333444455",
      text: "## 進捗\n```mermaid\ngraph TD\n```",
    });
  });

  test("ハンドラの ok:false は status/error をそのまま返す", async () => {
    onChannelPost(async () => ({
      ok: false,
      status: 404,
      error: "スレッドが見つかりません",
    }));
    const res = await fetch(channelPostUrl("000000000000000000"), {
      method: "POST",
      body: JSON.stringify({ text: "t" }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toContain("スレッド");
  });

  test("ハンドラ throw は 500（unhandled で落ちない）", async () => {
    onChannelPost(async () => {
      throw new Error("kaboom");
    });
    const res = await fetch(channelPostUrl("111122223333444455"), {
      method: "POST",
      body: JSON.stringify({ text: "t" }),
    });
    expect(res.status).toBe(500);
  });

  test("stopRelayServer でハンドラがリセットされる（再 start 後は 503）", async () => {
    onChannelPost(async () => ({ ok: true, channelId: "C1", chunks: 1 }));
    stopRelayServer();
    startRelayServer();
    const res = await fetch(channelPostUrl("111122223333444455"), {
      method: "POST",
      body: JSON.stringify({ text: "t" }),
    });
    expect(res.status).toBe(503);
  });
});
