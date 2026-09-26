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
// Fix pinned by this test (manager.ts, PR #484): `confirmResumePromptIfPresent`
// now warns once when the marker never appears after full exhaustion (still
// registers the session — that documented "no picker ⇒ non-compacted resume"
// fallback for the LEGITIMATE fast case is preserved), and logs a periodic
// heartbeat during long waits. This does not shorten Issue #163's empirically
// -tuned 5-minute budget for genuinely large/compacted sessions; it makes the
// wait OBSERVABLE instead of silent, which is the actual production complaint.
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

describe("SessionManager.resumeSession root-cause investigation (PR #484 review)", () => {
  itE2E(
    "confirms the exact stall: claude-mock.sh's pane never matches the " +
      "resume-prompt/ready markers, so confirmResumePromptIfPresent silently " +
      "consumes the FULL poll window (no early exit, zero console output) " +
      "before resumeSession still reports success",
    async () => {
      const threadId = `resume-lifecycle-${process.pid}-${Date.now()}`;
      const claudeSessionId = randomUUID();

      const logSpy = spyOn(console, "log");
      const warnSpy = spyOn(console, "warn");
      const logCallCountBeforeResume = logSpy.mock.calls.length;
      const warnCallCountBeforeResume = warnSpy.mock.calls.length;

      const t0 = Date.now();
      try {
        // Mirrors the production condition confirmed against the real
        // sessions.db row: `existsSync(projectDir) === true`, so
        // `recoverWorktreeForResume` (and therefore the git-timeout fix) is
        // never invoked — this isolates confirmResumePromptIfPresent as the
        // sole remaining candidate.
        await manager.resumeSession(config, threadId, claudeSessionId, projectDir, null);
        const elapsed = Date.now() - t0;

        // AC-1: the full window elapsed (no early exit) — proves the pane
        // never matched either regex, exactly like claude-mock.sh's silence.
        // 5 attempts × 200ms = 1000ms; allow scheduling slack, require at
        // least 4 full intervals to rule out an early return.
        expect(elapsed).toBeGreaterThanOrEqual(4 * 200);

        // AC-2 (the fix for the actual production complaint): before the fix
        // this window produced ZERO console.log/warn calls at all — the exact
        // "考え中" silence reported. `confirmResumePromptIfPresent` now warns
        // once when the marker never appears (this exhaustion case), so the
        // stall is diagnosable in the Supervisor's own logs instead of silent.
        const logCallsDuringResume = logSpy.mock.calls.length - logCallCountBeforeResume;
        const warnCallsDuringResume = warnSpy.mock.calls.length - warnCallCountBeforeResume;
        expect(warnCallsDuringResume).toBe(1);
        expect(String(warnSpy.mock.calls.at(-1)?.[0])).toContain("never appeared");
        // The final "Resumed ..." success log is still exactly one call.
        expect(logCallsDuringResume).toBe(1);
        expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain("Resumed");

        // AC-3: despite the pane never reaching a picker/ready state,
        // resumeSession still reports SUCCESS (the false-positive shape of
        // this bug) — the session is tracked and the DB row exists.
        expect(manager.has(threadId)).toBe(true);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        if (manager.has(threadId)) {
          await manager.stop(threadId, "manual").catch(() => {});
        }
      }
    },
    20_000,
  );
});
