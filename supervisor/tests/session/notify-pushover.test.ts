import { test, expect, describe, mock, spyOn } from "bun:test";
import {
  notifyPushover,
  warnIfPushoverUnconfigured,
} from "../../src/session/notify-pushover";

describe("notifyPushover", () => {
  test("skips (returns false) when credentials are unset", async () => {
    const fetchSpy = mock(async () => new Response("{}"));
    const ok = await notifyPushover("title", "msg", {
      env: {},
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test("skips when only token is set (no user key)", async () => {
    const fetchSpy = mock(async () => new Response("{}"));
    const ok = await notifyPushover("t", "m", {
      env: { token: "tok" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test("POSTs to Pushover and returns true on status:1", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchSpy = mock(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = String(init.body);
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    });
    const ok = await notifyPushover("Dialog stuck", "tmux attach -t claude-x", {
      env: { token: "tok123", userKey: "usr456" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(capturedUrl).toContain("api.pushover.net");
    expect(capturedBody).toContain("token=tok123");
    expect(capturedBody).toContain("user=usr456");
    expect(capturedBody).toContain("Dialog+stuck");
  });

  test("returns false on non-ok HTTP", async () => {
    const fetchSpy = mock(
      async () => new Response("nope", { status: 500 })
    );
    const ok = await notifyPushover("t", "m", {
      env: { token: "tok", userKey: "usr" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  test("returns false (never throws) when fetch rejects", async () => {
    const fetchSpy = mock(async () => {
      throw new Error("network down");
    });
    const ok = await notifyPushover("t", "m", {
      env: { token: "tok", userKey: "usr" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  test("returns false when API status is not 1", async () => {
    const fetchSpy = mock(
      async () => new Response(JSON.stringify({ status: 0 }), { status: 200 })
    );
    const ok = await notifyPushover("t", "m", {
      env: { token: "tok", userKey: "usr" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });
});

// Issue #255 (proposal C): warn at startup when Pushover is unconfigured so the
// operator knows paging is disabled, rather than discovering it only when a
// stall silently fails to page.
describe("warnIfPushoverUnconfigured (Issue #255)", () => {
  test("returns true and stays quiet when both credentials are set", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = warnIfPushoverUnconfigured({ token: "tok", userKey: "usr" });
      expect(ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test.each([
    ["both unset", {}],
    ["only token", { token: "tok" }],
    ["only userKey", { userKey: "usr" }],
  ])("returns false and warns when %s", (_label, env) => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = warnIfPushoverUnconfigured(env);
      expect(ok).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("paging is disabled");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
