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
const { COMPACT_BUTTON_ID } = await import("../../src/commands/compact-button");

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
  components?: unknown[];
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
    // #364: a compact button on a dead session would be a dead end — the reply
    // is resume guidance, so no button.
    expect(replies[0]!.components).toBeUndefined();
  });

  test("in a thread, live session → reply carries the one-click compact button (#364)", async () => {
    const threadId = "thread-status-live";
    const effects = createFakeEffects();
    manager = new SessionManager({ effects });
    insertSession({
      id: "status-live",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 7373,
      claude_session_id: "77777777-7777-7777-7777-777777777777",
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    // "稼働中" needs BOTH pid/tmux liveness and in-memory tracking (PR #179),
    // which is the same condition that gates the button.
    effects.process.alivePids.add(7373);
    await effects.tmux.newSession(`claude-${threadId.slice(0, 12)}`, "x");
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      threadId,
      { threadId }
    );

    const { interaction, replies } = makeInteraction({
      isThread: true,
      threadId,
    });
    await createSessionHandler(manager)(interaction as never);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toContain("稼働中");
    expect(replies[0]!.components).toHaveLength(1);
    expect(JSON.stringify(replies[0]!.components)).toContain(
      COMPACT_BUTTON_ID
    );
  });

  test("liveness is evaluated exactly once per status (3s deadline guard, #364)", async () => {
    // livenessOf runs `tmux has-session` with a 2s timeout and, on timeout,
    // waits the full 2s before assuming alive (#238). Two evaluations can
    // therefore exceed Discord's 3s initial-response deadline and make
    // /session status itself fail — the very "アプリケーションが応答しません
    // でした" symptom #364 exists to remove. They can also disagree, leaving
    // the text and the button inconsistent.
    const threadId = "thread-status-once";
    const effects = createFakeEffects();
    manager = new SessionManager({ effects });
    insertSession({
      id: "status-once",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 7474,
      claude_session_id: "88888888-8888-8888-8888-888888888888",
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    effects.process.alivePids.add(7474);
    await effects.tmux.newSession(`claude-${threadId.slice(0, 12)}`, "x");
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      threadId,
      { threadId }
    );

    let livenessCalls = 0;
    const realLivenessOf = manager.livenessOf.bind(manager);
    manager.livenessOf = async (id: string) => {
      livenessCalls++;
      return realLivenessOf(id);
    };

    const { interaction } = makeInteraction({ isThread: true, threadId });
    await createSessionHandler(manager)(interaction as never);

    expect(livenessCalls).toBe(1);
  });

  test("dead session: liveness is still evaluated only once (#364)", async () => {
    // The salvage path used to re-derive the verdict inside buildSalvageReply.
    const threadId = "thread-status-dead-once";
    const effects = createFakeEffects();
    manager = new SessionManager({ effects });
    insertSession({
      id: "status-dead-once",
      channel_name: "agent-base",
      thread_id: threadId,
      project_dir: "/tmp/x",
      pid: 7575,
      claude_session_id: "99999999-9999-9999-9999-999999999999",
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status: "running",
    });
    updateSessionStatus("status-dead-once", "stopped", "process_dead");

    let livenessCalls = 0;
    const realLivenessOf = manager.livenessOf.bind(manager);
    manager.livenessOf = async (id: string) => {
      livenessCalls++;
      return realLivenessOf(id);
    };

    const { interaction, replies } = makeInteraction({ isThread: true, threadId });
    await createSessionHandler(manager)(interaction as never);

    expect(livenessCalls).toBe(1);
    expect(replies[0]!.content).toContain("停止しています");
  });
});
