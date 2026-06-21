/**
 * Resume-backed auto-restart orchestration for a critical-context session
 * (Issue #244, the follow-up #206 deferred).
 *
 * When the self-heal planner decides `restart` (context crossed into the
 * critical band, under the per-session cap), this drives the recovery:
 *
 *   1. stop the old (critical) session  — frees the claude session id so the
 *      resume's liveness re-check sees it as dead and proceeds.
 *   2. create a fresh Discord thread     — a clean view; the old thread is left
 *      with a pointer to it.
 *   3. `claude --resume <id>` into it     — carries the FULL conversation history
 *      across (resumeSession in SessionManager).
 *   4. link the new thread from the old   — so the user can follow the move.
 *
 * Every Discord / SessionManager side effect is injected so this is unit-testable
 * with fakes (mirrors runDispatch's `createThread` callback). The function NEVER
 * throws: it runs on the best-effort relay tail, and any failure degrades to the
 * manual `/session resume <id>` guidance posted in the old thread — a silent
 * failure here would strand the user at an unusable 800k-token session (RW-047
 * resume-timing flake is exactly such a failure, so it must degrade loudly).
 */

export interface SelfHealRestartDeps {
  /** The claude session id to resume (carried in the outcome before the stop). */
  claudeSessionId: string;
  /** Context tokens at the crossing (for the user-facing messages). */
  tokens: number;
  /**
   * Stop the old session. Must complete before resume so the claude session's
   * liveness flips to dead (else resumeSession rejects "already running").
   * Throwing → degrade.
   */
  stopOld: () => Promise<void>;
  /**
   * Create the fresh Discord thread the session resumes into. `mention` is a
   * thread reference (`<#id>`) for the link posted back to the old thread.
   * Throwing → degrade.
   */
  createThread: () => Promise<{ id: string; mention: string }>;
  /** Resume the claude session into the new thread. Throwing (incl. RW-047 timeout) → degrade. */
  resume: (newThreadId: string) => Promise<void>;
  /** Post a message into the OLD (critical) thread. Best-effort; failure is swallowed. */
  notifyOld: (message: string) => Promise<void>;
  /** Post the welcome into the NEW thread on success. Best-effort; failure is swallowed. */
  notifyNew?: (newThreadId: string, message: string) => Promise<void>;
}

export interface SelfHealRestartResult {
  /** True only when the resume into the new thread succeeded. */
  ok: boolean;
  /** Set on success: the thread the session was resumed into. */
  newThreadId?: string;
  /** True when restart could not complete and we fell back to manual guidance. */
  degraded?: boolean;
  /** Failure detail (developer-facing); never surfaced raw to users. */
  error?: string;
}

/**
 * Manual-recovery guidance posted to the old thread when auto-restart cannot
 * complete. Always names the concrete `/session resume <id>` so the user has a
 * one-step recovery — no silent failure (#244 AC item 3).
 */
export function manualRestartGuidance(
  claudeSessionId: string,
  reason: string
): string {
  return (
    `⚠️ コンテキストが critical に到達しましたが、自動 restart に失敗しました（${reason}）。\n` +
    `手動で \`/session resume ${claudeSessionId}\` を実行して会話を引き継いで復帰してください (#244)。`
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function executeSelfHealRestart(
  deps: SelfHealRestartDeps
): Promise<SelfHealRestartResult> {
  const { claudeSessionId, tokens } = deps;

  // Best-effort post helper: the degrade path MUST reach the user, so a
  // notifyOld failure here is logged and swallowed rather than masking the
  // original error or throwing out of the relay tail.
  const degrade = async (
    reason: string,
    err: unknown
  ): Promise<SelfHealRestartResult> => {
    try {
      await deps.notifyOld(manualRestartGuidance(claudeSessionId, reason));
    } catch (notifyErr) {
      console.warn(
        `[self-heal-restart] failed to post degrade guidance: ${errMsg(notifyErr)}`
      );
    }
    return { ok: false, degraded: true, error: errMsg(err) };
  };

  // 1. Stop the old session (frees the claude session for resume).
  try {
    await deps.stopOld();
  } catch (err) {
    return degrade("旧セッションの停止に失敗", err);
  }

  // 2. Create the fresh thread.
  let thread: { id: string; mention: string };
  try {
    thread = await deps.createThread();
  } catch (err) {
    return degrade("新スレッドの作成に失敗", err);
  }

  // 3. Resume into the new thread (RW-047: a timing failure throws here).
  try {
    await deps.resume(thread.id);
  } catch (err) {
    return degrade("resume に失敗", err);
  }

  // 4. Success — link the new thread from the old, welcome in the new.
  const k = Math.floor(tokens / 1000);
  try {
    await deps.notifyOld(
      `🔄 コンテキストが ${k}k（critical）に到達したため、会話を引き継いで自動 restart しました → ${thread.mention} (#244)。\n` +
        `このスレッドはここで終了します。続きは新スレッドで操作してください。`
    );
  } catch (err) {
    console.warn(
      `[self-heal-restart] resumed but failed to link new thread in old: ${errMsg(err)}`
    );
  }
  if (deps.notifyNew) {
    try {
      await deps.notifyNew(
        thread.id,
        `♻️ 高コンテキスト self-heal により前スレッドから自動復帰しました（resume, #244）。\n` +
          `前回の会話を引き継いでいます。このスレッドにメッセージを送ると中継されます。`
      );
    } catch (err) {
      console.warn(
        `[self-heal-restart] resumed but failed to welcome new thread: ${errMsg(err)}`
      );
    }
  }

  return { ok: true, newThreadId: thread.id };
}
