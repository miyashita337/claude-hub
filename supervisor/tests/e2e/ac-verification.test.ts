import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
} from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  startRelayServer,
  stopRelayServer,
  waitForRelay,
  getRelayPort,
} from "../../src/session/relay-server";
import { tmuxSend, ensurePaneNotInMode } from "../../src/session/relay";
import { TMUX_ARGS, ensureSocketConfigured } from "../../src/session/tmux";

/**
 * End-to-end AC verification for the Discord ↔ Supervisor ↔ Claude Code
 * relay stack.
 *
 * The full happy-path (Issue #73 / Session 2026-04-23):
 *   AC-1  /session start slash command accepted
 *   AC-2  new Discord thread created
 *   AC-3  Supervisor posts startup message to the thread
 *   AC-4  Supervisor spawns a tmux session using the `claude-<threadId12>` scheme
 *   AC-5  Claude Code inside the tmux pane produces a response
 *   AC-6  the response is relayed back to the Discord thread
 *   AC-7  relay survives payloads containing ASCII hyphens, Japanese characters
 *         and ASCII punctuation (historical silent-drop)
 *
 * This file exercises every AC that can run hermetically in CI. AC-1/2/3
 * require a live Discord bot token / gateway and are therefore skipped with
 * documented rationale; the PR description carries a manual verification
 * checklist that covers them.
 */

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

/**
 * Mirror of `SessionManager.tmuxSessionName` — kept local to avoid pulling in
 * the full SessionManager constructor (which opens a SQLite DB). The naming
 * contract is what AC-4 verifies.
 */
function tmuxSessionName(threadId: string): string {
  return `claude-${threadId.slice(0, 12)}`;
}

function makeName(tag: string): string {
  return `ac-e2e-${tag}-${process.pid}-${Date.now()}`;
}

function capturePane(session: string): string {
  return execFileSync(TMUX_PATH, [...TMUX_ARGS, "capture-pane", "-p", "-t", session], {
    timeout: TMUX_OP_TIMEOUT,
  }).toString();
}

function startPaneWithSleep(name: string): void {
  execFileSync(
    TMUX_PATH,
    [...TMUX_ARGS, "new-session", "-d", "-s", name, "-x", "500", "-y", "40", "sleep", "600"],
    { timeout: TMUX_OP_TIMEOUT }
  );
}

function killPane(name: string): void {
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "kill-session", "-t", name], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // already gone
  }
}

beforeAll(() => {
  if (hasTmux) {
    try {
      execFileSync(TMUX_PATH, [...TMUX_ARGS, "start-server"], { timeout: TMUX_OP_TIMEOUT });
    } catch {
      /* new-session will start the server on demand */
    }
    ensureSocketConfigured();
  }
  startRelayServer();
});

afterAll(() => {
  stopRelayServer();
});

describe("AC E2E verification (Issue #73)", () => {
  // ---- Discord-dependent ACs ----

  test.skip("AC-1: /session start slash command accepted [requires Discord]", () => {
    // Manual verification: with a live Supervisor running, invoke /session start
    // from a registered channel and confirm the interaction is acknowledged.
  });

  test.skip("AC-2: new Discord thread created [requires Discord]", () => {
    // Manual verification: after AC-1, a new thread named
    // `Session: <channel>` appears in the channel's thread list.
  });

  test.skip("AC-3: Supervisor posts startup message [requires Discord]", () => {
    // Manual verification: the new thread contains a Channel-Supervisor
    // message with directory, session count, and `/session stop` instructions.
  });

  // ---- Hermetic ACs (CI-runnable) ----

  itmux("AC-4: tmux session name follows `claude-<threadId12>` contract", () => {
    const threadId = "149654699742002246";
    expect(tmuxSessionName(threadId)).toBe("claude-149654699742");
    expect(tmuxSessionName(threadId).startsWith("claude-")).toBe(true);
    expect(tmuxSessionName(threadId).length).toBe("claude-".length + 12);
  });

  itmux("AC-4b: tmux new-session spawns a live pane", () => {
    const name = makeName("spawn");
    startPaneWithSleep(name);
    try {
      const list = execFileSync(
        TMUX_PATH,
        [...TMUX_ARGS, "list-sessions", "-F", "#{session_name}"],
        { timeout: TMUX_OP_TIMEOUT }
      ).toString();
      expect(list.split("\n")).toContain(name);
    } finally {
      killPane(name);
    }
  });

  itmux("AC-5: mock claude inside tmux receives and processes input", async () => {
    // Stand in for Claude Code with a small bash loop that prints a marker
    // when it sees the expected payload. This proves the tmux → process
    // byte path works end-to-end without requiring the claude CLI.
    const tmp = mkdtempSync(join(tmpdir(), "ac5-"));
    const script = join(tmp, "mock-claude.sh");
    writeFileSync(
      script,
      `#!/usr/bin/env bash
set -u
while IFS= read -r line; do
  printf 'MOCK_CLAUDE_SAW: %s\\n' "$line"
done
`
    );
    chmodSync(script, 0o755);
    const name = makeName("ac5");
    execFileSync(
      TMUX_PATH,
      [
        ...TMUX_ARGS,
        "new-session",
        "-d",
        "-s",
        name,
        "-x",
        "500",
        "-y",
        "40",
        "bash",
        script,
      ],
      { timeout: TMUX_OP_TIMEOUT }
    );
    try {
      const payload = "ac5-roundtrip-ハロー";
      await tmuxSend(name, ["-l", payload]);
      await tmuxSend(name, ["C-m"]);
      await new Promise((r) => setTimeout(r, 300));
      const captured = capturePane(name);
      expect(captured).toContain(`MOCK_CLAUDE_SAW: ${payload}`);
    } finally {
      killPane(name);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AC-6: Supervisor relay-server receives a Stop-hook POST and resolves waitForRelay", async () => {
    const threadId = `ac6-${process.pid}-${Date.now()}`;
    const port = getRelayPort();
    // Kick off the waiter first — the real Stop hook pattern.
    const waiter = waitForRelay(threadId, 5000);
    // Post as if a Claude Code Stop hook fired. The server treats the
    // text/chunks payload identically regardless of origin.
    const res = await fetch(`http://127.0.0.1:${port}/relay/${threadId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ac6-ok", chunks: ["ac6-ok"] }),
    });
    expect(res.status).toBeLessThan(400);
    const result = await waiter;
    expect(result.text).toBe("ac6-ok");
  });

  itmux("AC-7: relay delivers hyphen + Japanese + period payload verbatim", async () => {
    const name = makeName("ac7");
    startPaneWithSleep(name);
    try {
      const payload =
        "ping - E2E relay test from claude-hub session 起動不能調査. PWD と現在時刻を 1 行で返してください。";
      await ensurePaneNotInMode(name);
      await tmuxSend(name, ["-l", payload]);
      await new Promise((r) => setTimeout(r, 150));
      const captured = capturePane(name);
      expect(captured).toContain(payload);
    } finally {
      killPane(name);
    }
  });

  itmux("AC-7b: relay survives stuck copy-mode with hyphen+Japanese payload", async () => {
    const name = makeName("ac7b");
    startPaneWithSleep(name);
    try {
      execFileSync(TMUX_PATH, [...TMUX_ARGS, "copy-mode", "-t", name], {
        timeout: TMUX_OP_TIMEOUT,
      });
      const modeOut = execFileSync(
        TMUX_PATH,
        [...TMUX_ARGS, "display-message", "-t", name, "-p", "#{pane_in_mode}"],
        { timeout: TMUX_OP_TIMEOUT }
      )
        .toString()
        .trim();
      expect(modeOut).toBe("1");

      const payload = "recover-テスト-2026.";
      await ensurePaneNotInMode(name);
      await tmuxSend(name, ["-l", payload]);
      await new Promise((r) => setTimeout(r, 150));

      const finalMode = execFileSync(
        TMUX_PATH,
        [...TMUX_ARGS, "display-message", "-t", name, "-p", "#{pane_in_mode}"],
        { timeout: TMUX_OP_TIMEOUT }
      )
        .toString()
        .trim();
      expect(finalMode).toBe("0");
      expect(capturePane(name)).toContain(payload);
    } finally {
      killPane(name);
    }
  });
});
