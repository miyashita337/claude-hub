import { CHANNEL_MAP, type ChannelConfig } from "../config/channels";
import { getSessionByThreadId } from "../infra/db";
import type { SessionRow } from "../infra/db";
import type { Liveness } from "./manager";

/**
 * Message-triggered wake (Issue #456).
 *
 * A thread keeps its session history in sessions.db forever, but the session
 * itself does not survive: a supervisor restart stops every session with
 * `supervisor_restart`, the DispatchHealthReaper reaps quiet dispatch sessions,
 * and the idle reaper eventually takes the rest. Before this module the next
 * message in such a thread only ever produced resume *guidance*
 * (session/status-reply.ts), so a conversation that rallies over hours or days
 * — corp's decision-feedback threads are the motivating case — needed a manual
 * `/session resume <id>` every single time.
 *
 * This turns an inbound message into the wake trigger: if the thread has
 * history we resume THAT session INTO THAT SAME thread and let the caller relay
 * the triggering message into it. Threads with no history are deliberately left
 * alone — an unknown thread must never auto-start a session (#456 AC-2).
 *
 * Failures are loud (#456 AC-3): a full MAX_SESSIONS table or a deleted
 * worktree returns a notice for the caller to post, never silence.
 *
 * The logic lives here rather than in bot.ts so it is unit-testable against the
 * fake adapters, and so bot.ts's messageCreate path stays a thin dispatcher.
 */

/** Log prefix — AC-1 asserts the supervisor log records the auto-resume. */
const LOG = "[AutoResume]";

/**
 * The slice of {@link import("./manager").SessionManager} this module needs.
 * Structural, so the real manager satisfies it without a cast while tests can
 * drive the decision path with a stub.
 */
export interface AutoResumeSessions {
  livenessOf(threadId: string): Promise<Liveness>;
  resumeSession(
    config: ChannelConfig,
    threadId: string,
    claudeSessionId: string,
    projectDir: string,
    branch?: string | null,
  ): Promise<unknown>;
}

export type AutoResumeOutcome =
  /**
   * Resumed into this thread; the caller relays the triggering message.
   *
   * `notice` is null for a caller that merely JOINED an in-flight attempt (see
   * {@link inFlight}) — the resume was already announced for the message that
   * started it, and repeating it would post the same banner once per line the
   * user typed.
   */
  | { kind: "resumed"; claudeSessionId: string; notice: string | null }
  /** Never-seen thread (#456 AC-2): the caller keeps its pre-#456 behaviour. */
  | { kind: "no-history" }
  /**
   * History exists but resume must not be attempted. `alive` means the process
   * is up while the Supervisor lost tracking — resuming a live claude session
   * in the same cwd corrupts its transcript (RW-046) — and
   * `no-claude-session-id` is a pre-#167 row with nothing to resume from. Both
   * are exactly what the salvage reply already explains, so the caller falls
   * back to it instead of inventing a second wording.
   */
  | {
      kind: "not-resumable";
      reason: "alive" | "no-claude-session-id";
      /**
       * The verdict this decision was made on. Handed to the caller so
       * `buildSalvageReply` reuses it instead of re-deriving it — `livenessOf`
       * runs a tmux call with a 2s timeout, and on timeout waits the full 2s
       * (#238), so re-deriving costs the user real latency on every message in
       * a dead thread (same reason #364 resolves it once).
       */
      verdict: Liveness;
    }
  /**
   * Resume was attempted (or blocked) and failed: post `notice` (#456 AC-3).
   * `notice` is null for a joined in-flight attempt, as for `resumed`.
   */
  | { kind: "failed"; reason: string; notice: string | null };

export interface AutoResumeDeps {
  channelMap?: ReadonlyMap<string, ChannelConfig>;
  lookupSession?: (threadId: string) => SessionRow | undefined;
}

/**
 * In-flight attempts, keyed by thread. A resume takes seconds (tmux spawn plus
 * the "Resume from summary" confirm), and a user typing two lines in a row
 * would otherwise start a second resume that `resumeSession` rejects — turning
 * a normal double-post into a spurious failure notice. Sharing the promise
 * makes the second message wait for the first attempt and observe its outcome.
 */
const inFlight = new Map<string, Promise<AutoResumeOutcome>>();

/**
 * Resume the thread's last session into the thread itself, if it has one.
 *
 * Never throws: every failure is reported as a `failed` outcome carrying the
 * notice to post, so a caller in Discord's messageCreate path cannot be taken
 * down by this (agent-output-quality #1 — no silent fallback, and no crash).
 */
export function autoResumeThread(
  sessions: AutoResumeSessions,
  threadId: string,
  deps: AutoResumeDeps = {},
): Promise<AutoResumeOutcome> {
  const existing = inFlight.get(threadId);
  // A joiner observes the initiator's outcome but must not repeat its notice.
  if (existing) return existing.then(withoutNotice);

  const run = attempt(sessions, threadId, deps).finally(() => {
    inFlight.delete(threadId);
  });
  inFlight.set(threadId, run);
  return run;
}

async function attempt(
  sessions: AutoResumeSessions,
  threadId: string,
  deps: AutoResumeDeps,
): Promise<AutoResumeOutcome> {
  try {
    return await decide(sessions, threadId, deps);
  } catch (err) {
    // The "never throws" contract, enforced in one place. bot.ts awaits this
    // straight from the messageCreate handler, so a rejection escaping here is
    // an unhandled rejection AND leaves the user with nothing back — exactly
    // the silence #456 exists to remove. Anything unexpected (a locked DB in
    // the history lookup, a liveness probe that blew up) becomes a loud outcome
    // instead. Note this must NOT swallow it into "no-history": that would let
    // the caller answer "セッション履歴がありません" for a thread that has one.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} thread ${threadId} failed unexpectedly: ${reason}`);
    return {
      kind: "failed",
      reason,
      notice:
        `⚠️ このスレッドのセッションを自動復帰できませんでした: ${reason}\n` +
        "supervisor のログを確認してください。",
    };
  }
}

async function decide(
  sessions: AutoResumeSessions,
  threadId: string,
  deps: AutoResumeDeps,
): Promise<AutoResumeOutcome> {
  const lookupSession = deps.lookupSession ?? getSessionByThreadId;
  const channelMap = deps.channelMap ?? CHANNEL_MAP;

  const row: SessionRow | undefined = lookupSession(threadId);
  if (!row) return { kind: "no-history" };

  // Authoritative liveness (#168), not the DB status column: a supervisor that
  // was SIGKILLed leaves `status='running'` behind on a process that is gone.
  const verdict = await sessions.livenessOf(threadId);
  if (verdict === "unknown") return { kind: "no-history" };
  if (verdict === "alive") {
    return { kind: "not-resumable", reason: "alive", verdict };
  }

  const claudeSessionId = row.claude_session_id;
  if (!claudeSessionId) {
    return { kind: "not-resumable", reason: "no-claude-session-id", verdict };
  }

  const config = channelMap.get(row.channel_name);
  if (!config) {
    // The channel was renamed or removed from CHANNEL_MAP since the session
    // ran. Resume needs its dir / flags, so there is nothing to launch.
    const reason = `チャンネル ${row.channel_name} は CHANNEL_MAP に未登録です`;
    console.warn(`${LOG} thread ${threadId}: ${reason}`);
    return { kind: "failed", reason, notice: failureNotice(reason, claudeSessionId) };
  }

  console.log(
    `${LOG} resuming thread ${threadId} (channel ${config.channelName}, claude session ${claudeSessionId})`,
  );
  try {
    await sessions.resumeSession(
      config,
      threadId,
      claudeSessionId,
      row.project_dir,
      row.branch,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG} thread ${threadId} failed: ${reason}`);
    return { kind: "failed", reason, notice: failureNotice(reason, claudeSessionId) };
  }

  console.log(
    `${LOG} resumed thread ${threadId} (claude session ${claudeSessionId})`,
  );
  return {
    kind: "resumed",
    claudeSessionId,
    notice:
      "♻️ セッションが停止していたため自動で復帰しました。前回の会話を引き継いで応答します。\n" +
      `🔑 claude_session_id: \`${claudeSessionId}\``,
  };
}

/** Strip the announcement from an outcome handed to a joined-in-flight caller. */
function withoutNotice(outcome: AutoResumeOutcome): AutoResumeOutcome {
  if (outcome.kind === "resumed" || outcome.kind === "failed") {
    return { ...outcome, notice: null };
  }
  return outcome;
}

function failureNotice(reason: string, claudeSessionId: string): string {
  return (
    `⚠️ このスレッドのセッションを自動復帰できませんでした: ${reason}\n` +
    `▶️ 手動で復帰する場合: \`/session resume ${claudeSessionId}\``
  );
}
