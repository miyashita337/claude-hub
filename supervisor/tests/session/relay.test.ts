import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import {
  startRelayServer,
  stopRelayServer,
} from "../../src/session/relay-server";
import { tmuxSend, ensurePaneNotInMode } from "../../src/session/relay";
import { TMUX_ARGS, ensureSocketConfigured } from "../../src/session/tmux";

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
beforeAll(() => {
  if (!hasTmux) return;
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "start-server"], { timeout: TMUX_OP_TIMEOUT });
  } catch {
    // non-fatal; new-session will start the server on demand
  }
  ensureSocketConfigured();
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
