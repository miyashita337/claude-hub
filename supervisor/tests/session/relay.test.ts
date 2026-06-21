import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import {
  startRelayServer,
  stopRelayServer,
} from "../../src/session/relay-server";
import {
  tmuxSend,
  ensurePaneNotInMode,
  flattenForSendKeys,
  readRelayTimeoutMs,
  DEFAULT_RELAY_TIMEOUT_MS,
  RELAY_TIMEOUT_FLOOR_MS,
  RELAY_TIMEOUT_CEILING_MS,
} from "../../src/session/relay";
import { DEFAULT_STALL_DELAY_MS } from "../../src/session/stall-heartbeat";
import { TMUX_ARGS, ensureSocketConfigured } from "../../src/session/tmux";

// Issue #210: the newline-flatten regex was double-escaped (`/[\\r\\n]+/`) so it
// matched only the literal chars `\`, `r`, `n` and never removed real CR/LF.
// Multi-line Discord messages kept their newlines, so `send-keys -l` submitted
// at the first newline and the input was split/corrupted -> silent drop -> stall.
describe("flattenForSendKeys (Issue #210)", () => {
  test("AC-1: mixed LF and CRLF collapse to single spaces", () => {
    expect(flattenForSendKeys("A\nB\r\nC")).toBe("A B C");
  });

  test("a run of consecutive newlines collapses to ONE space (the `+` quantifier)", () => {
    expect(flattenForSendKeys("A\n\n\nB")).toBe("A B");
    expect(flattenForSendKeys("A\r\n\r\nB")).toBe("A B");
  });

  test("a newline-only string flattens to a single space, not empty", () => {
    expect(flattenForSendKeys("\n")).toBe(" ");
    expect(flattenForSendKeys("\r\n\r\n")).toBe(" ");
  });

  test("bare CR and bare LF are both removed", () => {
    expect(flattenForSendKeys("A\rB")).toBe("A B");
    expect(flattenForSendKeys("A\nB")).toBe("A B");
  });

  test("a single-line message is returned unchanged", () => {
    expect(flattenForSendKeys("just one line")).toBe("just one line");
  });

  test("a leading `--` (tmux flag-like) line is preserved as literal text", () => {
    // The dangerous part for tmux is argv injection, handled by `-l`; flatten
    // only normalizes newlines and must not mangle the rest of the content.
    expect(flattenForSendKeys("next:\n- a\n- b")).toBe("next: - a - b");
  });

  test("realistic 3-line bullet message becomes one prompt line", () => {
    const msg = "次から\n- note記事にヘッダ画像\n- nanobanana2で";
    expect(flattenForSendKeys(msg)).toBe(
      "次から - note記事にヘッダ画像 - nanobanana2で",
    );
  });

  test("the buggy double-escaped behavior is gone (regression guard)", () => {
    // The old regex would leave real newlines in place; assert they're gone.
    expect(flattenForSendKeys("A\nB\nC")).not.toContain("\n");
  });
});

describe("relayMessage", () => {
  beforeAll(() => {
    startRelayServer();
  });

  afterAll(() => {
    stopRelayServer();
  });

  test("module exports relayMessage function", async () => {
    const relay = await import("../../src/session/relay");
    expect(typeof relay.relayMessage).toBe("function");
  });

  test("relayMessage accepts threadId as second parameter", async () => {
    const relay = await import("../../src/session/relay");
    expect(relay.relayMessage.length).toBeGreaterThanOrEqual(3);
  });

  test("AttachmentInfo type is exported", async () => {
    const relay = await import("../../src/session/relay");
    expect(relay).toBeDefined();
  });
});

// Integration tests below require a working `tmux` binary. Skip automatically
// when tmux is missing (some minimal CI runners).
const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";
function tmuxAvailable(): boolean {
  try {
    execFileSync(TMUX_PATH, ["-V"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

const hasTmux = tmuxAvailable();
const itmux = hasTmux ? test : test.skip;

const TMUX_OP_TIMEOUT = 10000;

function makeSessionName(tag: string): string {
  return `relay-test-${tag}-${process.pid}-${Date.now()}`;
}

function startSession(name: string): void {
  // `sleep` keeps the pane alive but does not read stdin, so send-keys
  // payloads simply land in the pane buffer where capture-pane can read them.
  // `-x 500` widens the pane so long Japanese payloads stay on a single line
  // (tmux wraps display at pane width, which would produce spurious newlines
  // in the captured output and break substring comparison).
  execFileSync(
    TMUX_PATH,
    [...TMUX_ARGS, "new-session", "-d", "-s", name, "-x", "500", "-y", "40", "sleep", "600"],
    { timeout: TMUX_OP_TIMEOUT }
  );
}

function killSession(name: string): void {
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "kill-session", "-t", name], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // already gone
  }
}

function capturePane(session: string): string {
  return execFileSync(TMUX_PATH, [...TMUX_ARGS, "capture-pane", "-p", "-t", session], {
    timeout: TMUX_OP_TIMEOUT,
  }).toString();
}

function paneInMode(session: string): boolean {
  const out = execFileSync(
    TMUX_PATH,
    [...TMUX_ARGS, "display-message", "-t", session, "-p", "#{pane_in_mode}"],
    { timeout: TMUX_OP_TIMEOUT }
  )
    .toString()
    .trim();
  return out === "1";
}

// Warm up the tmux server once so per-test new-session calls do not include
// server-startup latency (which can blow through short timeouts on CI). Also
// applies the Supervisor socket's global options (mouse off / mode-keys
// emacs) so tests exercise the production configuration.
beforeAll(async () => {
  if (!hasTmux) return;
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "start-server"], { timeout: TMUX_OP_TIMEOUT });
  } catch {
    // non-fatal; new-session will start the server on demand
  }
  // Issue #227 (PR-4): ensureSocketConfigured is async now — await it.
  await ensureSocketConfigured();
});

describe("tmuxSend integration (Issue #73 / AC-7)", () => {
  // AC-7: relay must deliver messages that contain hyphens, Japanese text and
  //       punctuation. Historically these failed with `not in a mode` because
  //       the retry path did not clear stuck copy-mode state.
  itmux("AC-7: delivers hyphen + Japanese + period payload verbatim", async () => {
    const name = makeSessionName("ac7");
    startSession(name);
    try {
      const payload =
        "ping - E2E relay test from claude-hub session 起動不能調査. PWD と現在時刻を 1 行で返してください。";
      await tmuxSend(name, ["-l", payload]);
      await new Promise((r) => setTimeout(r, 150));
      const captured = capturePane(name);
      expect(captured).toContain(payload);
    } finally {
      killSession(name);
    }
  });

  itmux("ensurePaneNotInMode exits copy-mode", async () => {
    const name = makeSessionName("mode");
    startSession(name);
    try {
      execFileSync(TMUX_PATH, [...TMUX_ARGS, "copy-mode", "-t", name], {
        timeout: TMUX_OP_TIMEOUT,
      });
      expect(paneInMode(name)).toBe(true);
      await ensurePaneNotInMode(name);
      expect(paneInMode(name)).toBe(false);
    } finally {
      killSession(name);
    }
  });

  // relayMessage() calls ensurePaneNotInMode BEFORE any send-keys. This test
  // mirrors that sequence against a pane intentionally stuck in copy-mode.
  itmux("ensurePaneNotInMode + tmuxSend recovers from stuck copy-mode", async () => {
    const name = makeSessionName("recovery");
    startSession(name);
    try {
      execFileSync(TMUX_PATH, [...TMUX_ARGS, "copy-mode", "-t", name], {
        timeout: TMUX_OP_TIMEOUT,
      });
      expect(paneInMode(name)).toBe(true);
      // Hyphen + Japanese + period: the exact shape that used to produce
      // `not in a mode` on the retry path (Issue #73).
      const payload = "hello-from-recovery-テスト.";
      await ensurePaneNotInMode(name);
      await tmuxSend(name, ["-l", payload]);
      await new Promise((r) => setTimeout(r, 150));
      expect(paneInMode(name)).toBe(false);
      const captured = capturePane(name);
      expect(captured).toContain(payload);
    } finally {
      killSession(name);
    }
  });

  // AC-6 for Issue #83: the original H2 reproducer. A pane stuck in
  // copy-mode + `send-keys -l <long_text>` with special characters used to
  // emit `not in a mode` × N and exit 1. After the fix (ensurePaneNotInMode
  // runs first via relay.ts / the socket-scoped `mouse off` prevents auto
  // re-entry), the send must succeed and deliver the payload verbatim.
  itmux("AC-6: long mixed text does not produce 'not in a mode'", async () => {
    const name = makeSessionName("ac6");
    startSession(name);
    try {
      execFileSync(TMUX_PATH, [...TMUX_ARGS, "copy-mode", "-t", name], {
        timeout: TMUX_OP_TIMEOUT,
      });
      // Reproduces the exact production payload class from the Issue #73
      // comment: Japanese + URL with &?= + trailing Japanese.
      const payload =
        "Skillを自動最適化するskill https://x.com/mizchi/status/2045501078574350450?s=46&t=5PQ3oSn6maqPw この記事を読んでagent-baseに組み込むべきか調査してAgentTeams召集";
      await ensurePaneNotInMode(name);
      await tmuxSend(name, ["-l", payload]);
      await new Promise((r) => setTimeout(r, 150));
      expect(paneInMode(name)).toBe(false);
      const captured = capturePane(name);
      expect(captured).toContain("Skillを自動最適化するskill");
      expect(captured).toContain("AgentTeams召集");
    } finally {
      killSession(name);
    }
  });
});

// Issue #74: integration coverage for the send-failure catch in relayMessage.
// The pure-function unit test (relay-send-failure.test.ts) locks
// buildSendFailureResult; this exercises the real production path where
// sendToPane throws (here: a nonexistent tmux session → "can't find session"),
// proving the raw tmux error never reaches the returned chunk.
describe("relayMessage send failure (#74)", () => {
  itmux(
    "returns a clean notice with no raw tmux internals when send-keys fails",
    async () => {
      const relay = await import("../../src/session/relay");
      const result = await relay.relayMessage(
        `relay-test-missing-${process.pid}-${Date.now()}`,
        "thread-irrelevant",
        "hello"
      );
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]).toBe(relay.SEND_FAILURE_USER_MESSAGE);
      // The screenshot symptom / raw tmux strings must never reach Discord.
      expect(result.chunks[0]).not.toMatch(/not in a mode/i);
      expect(result.chunks[0]).not.toMatch(/can't find (session|pane)/i);
      expect(result.chunks[0]).not.toMatch(/send-keys|tmux/i);
      // Raw cause is still preserved for diagnostics.
      expect(result.error).toBeTruthy();
      expect(result.text).toBe("");
    }
  );
});

// Issue #255 (proposal A): the relay timeout is env-tunable with a raised
// default, but must always stay above the stall heartbeat so a long *live*
// dispatch turn is paged (3 min) before — never instead of — the relay giving
// up. readRelayTimeoutMs is the single choke point that enforces this.
describe("readRelayTimeoutMs (Issue #255)", () => {
  test("default (env unset) is the raised 15-min default", () => {
    expect(readRelayTimeoutMs({})).toBe(DEFAULT_RELAY_TIMEOUT_MS);
    expect(DEFAULT_RELAY_TIMEOUT_MS).toBe(15 * 60_000);
  });

  test("invariant: default and floor both stay strictly above the stall delay", () => {
    // If this ever inverts, the stall heartbeat would never fire before the
    // relay timed out — the exact silent-stall regression #255 guards against.
    expect(RELAY_TIMEOUT_FLOOR_MS).toBeGreaterThan(DEFAULT_STALL_DELAY_MS);
    expect(DEFAULT_RELAY_TIMEOUT_MS).toBeGreaterThan(DEFAULT_STALL_DELAY_MS);
  });

  test("a valid positive env value (within bounds) is honored", () => {
    expect(readRelayTimeoutMs({ RELAY_TIMEOUT_MS: "600000" })).toBe(600_000);
  });

  test("a value below the floor is clamped up to the floor", () => {
    // 1s would put the relay below the 3-min stall heartbeat.
    expect(readRelayTimeoutMs({ RELAY_TIMEOUT_MS: "1000" })).toBe(
      RELAY_TIMEOUT_FLOOR_MS,
    );
  });

  test("a value above the ceiling is clamped down to the ceiling", () => {
    expect(readRelayTimeoutMs({ RELAY_TIMEOUT_MS: "999999999" })).toBe(
      RELAY_TIMEOUT_CEILING_MS,
    );
  });

  test.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["empty", ""],
  ])("falls back to the default for %s env values", (_label, raw) => {
    expect(readRelayTimeoutMs({ RELAY_TIMEOUT_MS: raw })).toBe(
      DEFAULT_RELAY_TIMEOUT_MS,
    );
  });
});
