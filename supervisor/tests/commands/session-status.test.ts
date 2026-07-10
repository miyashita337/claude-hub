// Isolate DB writes from the real sessions.db (mirrors tests/session/salvage-reply.test.ts).
// Must be set before any module that transitively loads infra/db is imported,
// so everything below uses dynamic import after the env is in place.
process.env.SUPERVISOR_DB_PATH = ":memory:";

import { test, expect, describe, beforeEach } from "bun:test";

const { insertSession, updateSessionStatus, getDb } = await import(
  "../../src/infra/db"
);
const { createSessionHandler } = await import("../../src/commands/session");
const { SessionManager } = await import("../../src/session/manager");
const { createFakeEffects } = await import("../../src/session/adapters-fake");

/**
 * Handler-level tests for `/session status` (Issue #349).
 *
 * `buildStatusReply` itself is already thoroughly covered by
 * tests/session/salvage-reply.test.ts (Issue #170). What's new here is the
 * thin `/session status` slash-command dispatch wrapper: the "must run inside
 * a thread" guard and that the handler actually forwards the real
 * `SessionManager` + thread id into `buildStatusReply` and relays its output
 * verbatim. Uses the real `SessionManager` class with fake in-memory effects
 * (no real tmux/process, same pattern as salvage-reply.test.ts) rather than a
 * hand-rolled stub, since `buildStatusReply` needs genuine liveness logic.
 */

interface ReplyRecord {
  content?: string;
  flags?: number;
}

function makeInteraction(opts: { isThread: boolean; threadId?: string }) {
  const replies: ReplyRecord[] = [];
  const channel = opts.isThread
    ? { id: opts.threadId ?? "thread-status-1", isThread: () => true }
    : { id: "channel-not-thread", isThread: () => false };

  const interaction = {
    options: {
      getSubcommand: () => "status",
      getString: () => null,
    },
    channel,
    deferred: false,
    replied: false,
    async reply(msg: ReplyRecord) {
      this.replied = true;
      replies.push(msg);
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(msg: ReplyRecord) {
      replies.push(msg);
    },
  };

  return { interaction, replies };
}

describe("/session status dispatch (#349)", () => {
  let manager: InstanceType<typeof SessionManager>;

  beforeEach(() => {
    getDb().run("DELETE FROM sessions");
    manager = new SessionManager({ effects: createFakeEffects() });
  });

  test("outside a thread → usage error, no DB/liveness lookup needed", async () => {
    const { interaction, replies } = makeInteraction({ isThread: false });
    await createSessionHandler(manager)(interaction as never);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.flags).toBe(64); // ephemeral
    expect(replies[0]!.content).toContain(
      "セッションスレッド内で実行してください"
    );
  });

  test("in a thread, no session history → salvage 'no history' wording", async () => {
    const { interaction, replies } = makeInteraction({
      isThread: true,
      threadId: "thread-status-none",
    });
    await createSessionHandler(manager)(interaction as never);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toContain("セッション履歴がありません");
  });

  test("in a thread, stopped session → 停止 wording with resume command (real handler → buildStatusReply)", async () => {
    const claudeId = "66666666-6666-6666-6666-666666666666";
    const threadId = "thread-status-dead";
    insertSession({
      id: "status-dead",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 7171,
      claude_session_id: claudeId,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    updateSessionStatus("status-dead", "stopped", "process_dead");

    const { interaction, replies } = makeInteraction({
      isThread: true,
      threadId,
    });
    await createSessionHandler(manager)(interaction as never);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toContain("停止しています");
    expect(replies[0]!.content).toContain(`/session resume ${claudeId}`);
  });
});
