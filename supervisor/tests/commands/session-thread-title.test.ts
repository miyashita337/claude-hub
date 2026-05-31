import { test, expect, describe } from "bun:test";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Issue #175 — integration-journey AC at the handler level: the `/session start`
 * command must create the Discord thread with a branch-based title, and append a
 * (N) suffix only when another session is already live on the *same* branch.
 *
 * We capture the name passed to `threads.create` from a fake interaction so the
 * assertion exercises the real handler wiring (same harness style as
 * session-start-branch.test.ts), without a Discord gateway.
 */
function makeStartInteraction(opts: {
  branch: string;
  // Sessions already running in this channel (to drive the same-branch count).
  // `branch` mirrors SessionInfo.branch, which start/resume both set (Issue #175).
  running?: { branch?: string }[];
}) {
  let createdName: string | undefined;
  const thread = { id: "thread-xyz", send: async () => {}, delete: async () => {} };

  const channel = {
    isThread: () => false,
    isTextBased: () => true,
    isDMBased: () => false,
    name: "agent-base", // → displayName "Agent Base" via CHANNEL_MAP
    threads: {
      create: async (o: { name: string }) => {
        createdName = o.name;
        return thread;
      },
    },
  };

  const interaction = {
    options: {
      getSubcommand: () => "start",
      getString: (name: string) => (name === "branch" ? opts.branch : null),
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
    listRunningByChannel: () => opts.running ?? [],
    listRunning: () => opts.running ?? [],
    start: () => ({
      worktree: {
        mainRepoDir: "/x",
        path: `/x/.claude/worktrees/${opts.branch}`,
        branch: opts.branch,
      },
    }),
  };

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    get createdName() {
      return createdName;
    },
  };
}

describe("/session start thread title (Issue #175)", () => {
  test("journey AC step 1: first session on a branch → 🟢 {branch} · {displayName}", async () => {
    const h = makeStartInteraction({ branch: "feat/167-foo" });
    await h.run();
    expect(h.createdName).toBe("🟢 feat/167-foo · Agent Base");
  });

  test("journey AC step 2: 2nd live session on the same branch → (2) suffix", async () => {
    const h = makeStartInteraction({
      branch: "feat/167-foo",
      running: [{ branch: "feat/167-foo" }],
    });
    await h.run();
    expect(h.createdName).toBe("🟢 feat/167-foo · Agent Base (2)");
  });

  test("a live session on a *different* branch does not bump the suffix", async () => {
    const h = makeStartInteraction({
      branch: "feat/167-foo",
      running: [{ branch: "other-branch" }],
    });
    await h.run();
    expect(h.createdName).toBe("🟢 feat/167-foo · Agent Base");
  });
});
