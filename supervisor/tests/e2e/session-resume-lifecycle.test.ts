// SessionManager.resumeSession ↔ real tmux root-cause investigation
// (PR #484 review, 2nd Discord E2E FAIL after the git-timeout fix).
//
// Real-world symptom (2026-09-27 04:42, #corp, claude_session_id
// 134a0815-94de-4cc5-a7c0-134db76d6759): `/session resume` created the
// hub-work-300 thread, then the Discord interaction sat at "考え中" for 90+
// seconds with ZERO console output and no sessions.db row — even though the
// git-timeout fix (worktree.ts, commit 34eec11) was already in place. The
// coordinator's read: the hang is AFTER thread creation and BEFORE (or
// entirely without) any logging, so it cannot be the git recovery path.
//
// Confirmed via the real production sessions.db (read-only query) that this
// session's recorded `project_dir` — a git worktree registered against the
// main claude-hub checkout — STILL EXISTS ON DISK (though checked out at a
// detached HEAD rather than its recorded branch). Since `resumeSession()`
// only calls `recoverWorktreeForResume` when `!existsSync(projectDir)`, the
// git recovery path (and therefore the timeout fix in worktree.ts) is never
// even reached for this session — consistent with the coordinator's finding
// that the git-timeout hypothesis does not explain this failure.
//
// This test drives `SessionManager.resumeSession` against REAL tmux (a
// dedicated test socket, isolated from the production `claude-hub` socket —
// RW-019) and the SAME `claude-mock.sh` fixture the existing session-lifecycle
// E2E already uses, so it exercises the exact code path with real subprocess
// timing instead of a fake/mocked tmux effects layer. `claude-mock.sh` only
// echoes lines read from stdin — it never prints anything resembling the
// `RESUME_PROMPT_RE` picker ("Resume from summary"/"Resume the full
// conversation") or the `RESUME_READY_RE` ready marker ("bypass permissions"/
// "? for shortcuts") until a message is actually sent to it. That is exactly
// the pane-content shape `confirmResumePromptIfPresent` (manager.ts) has NO
// escape hatch for: if neither marker EVER appears, the poll loop
// (`RESUME_PROMPT_POLL_ATTEMPTS` × `resumePromptPollIntervalMs`, production
// default 300 × 1000ms = up to 5 minutes, Issue #163) runs to full exhaustion
// with not a single `console.log`/`console.warn` call anywhere in that
// window — before FINALLY inserting the sessions.db row and logging success.
//
// Fix pinned by this test: PR #484 made the exhaustion observable (a warn
// plus a periodic heartbeat). Issue #485 added a liveness check to every poll:
// a session that is definitely gone fails immediately (unit-tested in
// manager-resume.test.ts). A pane that is still ALIVE when the attempts run
// out, like this mock, is still registered with a warn plus a stderr pane
// tail. It is not killed, so a slow, very large resume (self-heal) or a TUI
// wording change cannot become a hard failure. Issue #163's 5-minute budget is
// unchanged.
//
// Required env (self-skips otherwise, same gating as session-lifecycle.test.ts):
//   - SUPERVISOR_TMUX_SOCKET=claude-hub-test   (isolates from prod `claude-hub`)
//   - SUPERVISOR_CLAUDE_PATH=<abs path to fixtures/claude-mock.sh>
// CI (.github/workflows/ci.yml) injects both in the same step as
// session-lifecycle.test.ts.

import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { execFileSync } from "child_process";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "fs";
import { randomUUID } from "crypto";

import { SessionManager } from "../../src/session/manager";
import { TMUX_PATH, TMUX_ARGS, TMUX_SOCKET } from "../../src/session/tmux";
import { FakeItermAdapter } from "../../src/session/adapters-fake";
import type { ChannelConfig } from "../../src/config/channels";

const TMUX_OP_TIMEOUT = 10_000;
const REQUIRED_SOCKET = "claude-hub-test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, "fixtures/claude-mock.sh");

function tmuxAvailable(): boolean {
  try {
    execFileSync(TMUX_PATH, ["-V"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function realPathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const hasTmux = tmuxAvailable();
const correctSocket = TMUX_SOCKET === REQUIRED_SOCKET;
const envClaudePath = process.env.SUPERVISOR_CLAUDE_PATH;
const fixtureExists = existsSync(FIXTURE_PATH);
const correctClaudePath =
  envClaudePath !== undefined &&
  fixtureExists &&
  existsSync(envClaudePath) &&
  realPathOrSelf(envClaudePath) === realPathOrSelf(FIXTURE_PATH);
const enabled = hasTmux && correctSocket && correctClaudePath;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    `[session-resume-lifecycle.test] skipping (hasTmux=${hasTmux}, ` +
      `socket=${TMUX_SOCKET} required=${REQUIRED_SOCKET}, ` +
      `claudePath=${envClaudePath ?? "<unset>"} required=${FIXTURE_PATH}, ` +
      `fixtureExists=${fixtureExists})`,
  );
}

const itE2E = enabled ? test : test.skip;

let workDir: string;
let projectDir: string;
let manager: SessionManager;
let config: ChannelConfig;

beforeAll(async () => {
  if (!enabled) return;
  workDir = mkdtempSync(join(tmpdir(), "session-resume-lifecycle-"));
  projectDir = join(workDir, "project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# session resume lifecycle fixture\n");

  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "start-server"], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // new-session will start the server on demand.
  }

  // Short poll tuning so the test proves the MECHANISM quickly instead of
  // literally waiting out production's 5-minute budget — same code path
  // (confirmResumePromptIfPresent), same real tmux, same real claude-mock.sh
  // pane content, just a smaller multiplier. `resumePromptPollAttempts: 5` /
  // `resumePromptPollIntervalMs: 200` = a 1s worst-case window.
  manager = new SessionManager({
    effects: { iterm2: new FakeItermAdapter() },
    resumePromptPollAttempts: 5,
    resumePromptPollIntervalMs: 200,
    gracefulKillTimeoutMs: 0,
  });
  config = {
    channelName: "session-resume-lifecycle-test",
    dir: projectDir,
    displayName: "Session Resume Lifecycle Test",
  };
});

afterAll(async () => {
  if (!enabled) return;
  try {
    if (manager) await manager.shutdownAll();
  } catch {
    // best-effort; still kill the tmux server below.
  }
  try {
    execFileSync(TMUX_PATH, [...TMUX_ARGS, "kill-server"], {
      timeout: TMUX_OP_TIMEOUT,
    });
  } catch {
    // server already gone
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("SessionManager.resumeSession root-cause investigation (PR #484 review / Issue #485)", () => {
  itE2E(
    "claude-mock.sh's pane never matches the resume-prompt/ready markers: " +
      "confirmResumePromptIfPresent consumes the full poll window, then " +
      "resumeSession registers the still-alive session with a warn + stderr " +
      "pane tail (Issue #485 only fails a session that is definitely gone)",
    async () => {
      const threadId = `resume-lifecycle-${process.pid}-${Date.now()}`;
      const claudeSessionId = randomUUID();
      const tmuxName = SessionManager.tmuxSessionNameFor(threadId);

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const errSpy = spyOn(console, "error").mockImplementation(() => {});

      const t0 = Date.now();
      try {
        // Mirrors the production condition confirmed against the real
        // sessions.db row: `existsSync(projectDir) === true`, so
        // `recoverWorktreeForResume` is never invoked — this isolates
        // confirmResumePromptIfPresent.
        await manager.resumeSession(config, threadId, claudeSessionId, projectDir, null);
        const elapsed = Date.now() - t0;

        // The full window elapsed (no early exit): the pane never matched
        // either regex, and claude-mock.sh stays alive so the #485 liveness
        // check does not fire. 5 attempts × 200ms; require ≥ 4 intervals.
        expect(elapsed).toBeGreaterThanOrEqual(4 * 200);

        // The exhaustion is logged loudly (PR #484) ...
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes("never appeared"))
        ).toBe(true);
        // ... and the last pane lines go to stderr for diagnosis (#485).
        expect(
          errSpy.mock.calls.some((c) => String(c[0]).includes("last captured pane lines"))
        ).toBe(true);

        // The pane is really alive (the #485 liveness check saw it on every
        // poll), so the session is registered and left running, not killed.
        expect(manager.has(threadId)).toBe(true);
        let alive = true;
        try {
          execFileSync(TMUX_PATH, [...TMUX_ARGS, "has-session", "-t", tmuxName], {
            timeout: TMUX_OP_TIMEOUT,
            stdio: "ignore",
          });
        } catch {
          alive = false;
        }
        expect(alive).toBe(true);
      } finally {
        warnSpy.mockRestore();
        errSpy.mockRestore();
        if (manager.has(threadId)) {
          await manager.stop(threadId, "manual").catch(() => {});
        }
      }
    },
    20_000,
  );
});
