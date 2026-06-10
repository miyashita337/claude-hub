import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Issue #141 — integration (journey AC): `/session start` surfaces the
 * previous-session summary into the thread. The ECC SessionStart hook only
 * injects the summary into Claude's invisible context, so the Supervisor must
 * post it explicitly. We override the summary search dir (mirrors the
 * SUPERVISOR_ACCESS_JSON_PATH env-override pattern used elsewhere) and capture
 * thread.send to assert what reaches Discord.
 */

const FIXTURE_CHANNEL_ID = "fixture-parent-channel";
const FIXTURE_USER_ID = "fixture-user";
const TEST_WORKTREE = "/tmp/it-141-repo/.claude/worktrees/feat-foo";

let tmpRoot: string;
let summaryDir: string;
const prevAccessPath = process.env.SUPERVISOR_ACCESS_JSON_PATH;
const prevSummaryDirs = process.env.SUPERVISOR_SESSION_SUMMARY_DIRS;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "session-start-summary-"));
  const accessPath = join(tmpRoot, "access.json");
  writeFileSync(
    accessPath,
    JSON.stringify({
      groups: {
        [FIXTURE_CHANNEL_ID]: { requireMention: true, allowFrom: [FIXTURE_USER_ID] },
      },
    })
  );
  process.env.SUPERVISOR_ACCESS_JSON_PATH = accessPath;

  summaryDir = join(tmpRoot, "sessions");
  mkdirSync(summaryDir, { recursive: true });
  process.env.SUPERVISOR_SESSION_SUMMARY_DIRS = summaryDir;
});

afterEach(() => {
  if (prevAccessPath === undefined) delete process.env.SUPERVISOR_ACCESS_JSON_PATH;
  else process.env.SUPERVISOR_ACCESS_JSON_PATH = prevAccessPath;
  if (prevSummaryDirs === undefined) delete process.env.SUPERVISOR_SESSION_SUMMARY_DIRS;
  else process.env.SUPERVISOR_SESSION_SUMMARY_DIRS = prevSummaryDirs;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSummaryFile(worktree: string, body: string) {
  writeFileSync(
    join(summaryDir, "fixture-session.tmp"),
    [
      "# Session: 2026-06-10",
      "**Worktree:** " + worktree,
      "<!-- ECC:SUMMARY:START -->",
      body,
      "<!-- ECC:SUMMARY:END -->",
    ].join("\n")
  );
}

function makeInteraction() {
  const sentToThread: string[] = [];
  const thread = {
    id: "thread-summary",
    send: async (content: string) => {
      sentToThread.push(content);
    },
    delete: async () => {},
  };
  const channel = {
    id: FIXTURE_CHANNEL_ID,
    isThread: () => false,
    isTextBased: () => true,
    isDMBased: () => false,
    name: "agent-base",
    threads: { create: async () => thread },
  };
  const interaction = {
    user: { id: FIXTURE_USER_ID },
    options: {
      getSubcommand: () => "start",
      getString: (name: string) => (name === "branch" ? "feat-foo" : null),
    },
    channel,
    deferred: false,
    replied: false,
    async reply() {
      this.replied = true;
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply() {},
  };

  const sessionManager = {
    count: () => 0,
    listRunningByChannel: () => [],
    start: () => ({
      worktree: {
        mainRepoDir: "/tmp/it-141-repo",
        path: TEST_WORKTREE,
        branch: "feat-foo",
      },
    }),
  };

  return {
    run: () => createSessionHandler(sessionManager as never)(interaction as never),
    sentToThread,
  };
}

describe("/session start surfaces previous-session summary (#141)", () => {
  test("AC-1: matching summary is posted to the thread after welcome", async () => {
    writeSummaryFile(TEST_WORKTREE, "## Session Summary\n前回は #172 の note 下書きを作成");
    const h = makeInteraction();
    await h.run();

    // welcome + summary
    expect(h.sentToThread.length).toBe(2);
    const summaryMsg = h.sentToThread.find((m) => m.includes("前回セッションの要約"));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg).toContain("#172 の note 下書き");
  });

  test("AC-3: no matching summary → only the welcome message, no throw", async () => {
    writeSummaryFile("/some/other/repo/wt", "should NOT be posted");
    const h = makeInteraction();
    await h.run();

    expect(h.sentToThread.length).toBe(1);
    expect(h.sentToThread[0]).toContain("セッションを開始しました");
    expect(h.sentToThread.some((m) => m.includes("前回セッションの要約"))).toBe(false);
  });
});

// AC-2: /session resume surfaces the summary for the resumed project_dir.
const RESUME_PROJECT_DIR = "/tmp/it-141-repo";

function makeResumeInteraction() {
  const sentToThread: string[] = [];
  const thread = {
    id: "thread-resume-summary",
    send: async (content: string) => {
      sentToThread.push(content);
    },
    delete: async () => {},
  };
  const channel = {
    id: FIXTURE_CHANNEL_ID,
    isThread: () => false,
    isTextBased: () => true,
    isDMBased: () => false,
    name: "agent-base",
    parent: null,
    threads: { create: async () => thread },
  };
  const interaction = {
    user: { id: FIXTURE_USER_ID },
    options: {
      getSubcommand: () => "resume",
      getString: (name: string) => (name === "session_id" ? "sess-123" : null),
    },
    channel,
    deferred: false,
    replied: false,
    async reply() {
      this.replied = true;
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply() {},
  };

  const sessionManager = {
    count: () => 0,
    listRunningByChannel: () => [],
    findResumableSession: () => ({
      claude_session_id: "sess-123",
      channel_name: "agent-base",
      project_dir: RESUME_PROJECT_DIR,
      branch: "feat-foo",
    }),
    livenessOfClaudeSession: () => "dead",
    resumeSession: async () => {},
  };

  return {
    run: () => createSessionHandler(sessionManager as never)(interaction as never),
    sentToThread,
  };
}

describe("/session resume surfaces previous-session summary (#141)", () => {
  test("AC-2: matching summary for the resumed project_dir is posted", async () => {
    writeSummaryFile(RESUME_PROJECT_DIR, "## Session Summary\n復帰前の作業: #199 の compact 配線");
    const h = makeResumeInteraction();
    await h.run();

    const summaryMsg = h.sentToThread.find((m) => m.includes("前回セッションの要約"));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg).toContain("#199 の compact 配線");
  });
});
