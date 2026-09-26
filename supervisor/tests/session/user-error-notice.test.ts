import { test, expect, describe, spyOn } from "bun:test";
import {
  buildFailureNotice,
  logRawError,
  sanitizedFailureNotice,
} from "../../src/session/user-error-notice";

/**
 * Issue #360 (follow-up of #74 / #236): unit coverage for the shared
 * sanitization contract used by safeReplyError, every `/session <sub>` catch,
 * the channel-post HTTP handler, and the context-budget self-heal notice.
 * Same leakage shape as `tests/session/relay-error-notice.test.ts`
 * (`RELAY_ERROR_USER_MESSAGE` / `SEND_FAILURE_USER_MESSAGE`): a raw Node/Bun
 * error can carry an absolute filesystem path or arbitrary internal detail,
 * so it must never reach the returned string — only `console.error`.
 */

const LEAKY_ERROR = new Error(
  "ENOENT: no such file or directory, open '/Users/hiroyuki/.ssh/id_rsa'"
);

describe("sanitizedFailureNotice (#360)", () => {
  test("never embeds the raw error message or path", () => {
    const notice = sanitizedFailureNotice("test", "❌ 何かに失敗しました", LEAKY_ERROR);
    expect(notice).not.toContain("/Users/");
    expect(notice).not.toContain("ENOENT");
    expect(notice).not.toContain("id_rsa");
  });

  test("never embeds a non-Error throwable's String() form either", () => {
    const notice = sanitizedFailureNotice(
      "test",
      "❌ 何かに失敗しました",
      "raw string throw: /Users/hiroyuki/secret-token-abc123"
    );
    expect(notice).not.toContain("/Users/");
    expect(notice).not.toContain("secret-token");
  });

  test("keeps the caller-supplied action label and adds actionable recovery guidance", () => {
    const notice = sanitizedFailureNotice(
      "test",
      "❌ セッション起動に失敗しました",
      LEAKY_ERROR
    );
    expect(notice).toContain("❌ セッション起動に失敗しました");
    // Same contract as RELAY_ERROR_USER_MESSAGE (#236): tell the user how to
    // check state and recover, never leave them at a dead end.
    expect(notice).toContain("/session status");
  });

  test("logs the raw error object (stack preserved) via console.error, never dropping it", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      sanitizedFailureNotice("session start", "❌ セッション起動に失敗しました", LEAKY_ERROR);
      expect(spy).toHaveBeenCalledTimes(1);
      // Diagnostics keep the raw err OBJECT, not a stringified/truncated form,
      // so the stack trace survives in the Supervisor log (agent-output-quality
      // #1: no silent fallback).
      expect(spy.mock.calls[0]).toContain(LEAKY_ERROR);
      expect(spy.mock.calls[0]![0]).toContain("session start");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("buildFailureNotice (#360, devils-advocate review)", () => {
  test("is pure — never logs, just formats the message + recovery guidance", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const notice = buildFailureNotice("❌ エラーが発生しました");
      expect(notice).toContain("❌ エラーが発生しました");
      expect(notice).toContain("/session status");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("sanitizedFailureNotice's returned text matches buildFailureNotice's for the same message", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const viaSanitized = sanitizedFailureNotice("test", "❌ 何かに失敗しました", LEAKY_ERROR);
      const viaPure = buildFailureNotice("❌ 何かに失敗しました");
      expect(viaSanitized).toBe(viaPure);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("logRawError (#360)", () => {
  test("logs via console.error with a traceable label and the raw err object", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      logRawError("channel-post fetch thread", LEAKY_ERROR);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toContain("channel-post fetch thread");
      expect(spy.mock.calls[0]).toContain(LEAKY_ERROR);
    } finally {
      spy.mockRestore();
    }
  });
});
