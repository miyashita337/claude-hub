import type { SessionManager } from "./manager";
import { getSessionByThreadId } from "../infra/db";

/**
 * Shared formatters for "is this thread's session alive, and what's its id?"
 * replies (Epic #166). Both the dead-thread salvage path (Issue #169) and the
 * explicit status query (Issue #170) build on the authoritative liveness
 * verdict (Issue #168) so they never drift from each other.
 *
 * Kept in its own module (not bot.ts) so commands/session.ts can import it
 * without a circular dependency (bot.ts already imports commands/session.ts).
 */

/**
 * Salvage reply for a thread whose Supervisor session is no longer active in
 * memory (Issue #169). Gives the claude_session_id and a ready-to-paste resume
 * command instead of silence.
 *
 * Cases:
 *   - unknown (no DB row)         → no history; suggest /session start
 *   - alive (process still up)    → Supervisor lost tracking; suggest stop+resume/start
 *   - dead + claude_session_id    → stopped; offer `/session resume <id>`
 *   - dead + id missing           → pre-#167 row; suggest /session start
 */
export function buildSalvageReply(
  sessionManager: SessionManager,
  threadId: string
): string {
  const verdict = sessionManager.livenessOf(threadId);
  if (verdict === "unknown") {
    return "ℹ️ このスレッドにはセッション履歴がありません。`/session start` で開始してください。";
  }

  const row = getSessionByThreadId(threadId);
  // verdict !== "unknown" guarantees a row exists, but guard defensively.
  if (!row) {
    return "ℹ️ このスレッドにはセッション履歴がありません。`/session start` で開始してください。";
  }

  if (verdict === "alive") {
    // Process still up but Supervisor lost tracking. Only suggest resume when
    // we actually have an id to resume from — otherwise `/session resume` is
    // not actionable (gemini review on PR #178).
    if (row.claude_session_id) {
      return (
        "⚠️ このスレッドのセッションはプロセス上は生存していますが、Supervisor が管理を見失っています。" +
        `\`/session stop\` 後に \`/session resume ${row.claude_session_id}\`、または新規 \`/session start\` を検討してください。` +
        `\n🔑 claude_session_id: \`${row.claude_session_id}\``
      );
    }
    return (
      "⚠️ このスレッドのセッションはプロセス上は生存していますが、Supervisor が管理を見失っています。" +
      "claude_session_id は未記録のため、`/session stop` で停止後に `/session start` で起動し直してください。"
    );
  }

  // verdict === "dead"
  const reason = row.stopped_reason ? `（理由: ${row.stopped_reason}）` : "";
  if (row.claude_session_id) {
    return (
      `💀 このスレッドのセッションは停止しています${reason}。\n` +
      `🔑 claude_session_id: \`${row.claude_session_id}\`\n` +
      `▶️ 復帰: \`/session resume ${row.claude_session_id}\``
    );
  }
  return (
    `💀 このスレッドのセッションは停止しています${reason}。\n` +
    "🔑 claude_session_id は未記録です（#167 導入前に開始されたセッション）。`/session start` で新規起動してください。"
  );
}

/**
 * Status reply for an explicit query (Issue #170): `/session status` slash
 * command, or an `@Supervisor status` token. Unlike salvage, this can run on a
 * genuinely live + tracked thread, so the `alive` verdict means "running" —
 * not "Supervisor lost tracking". Dead/unknown reuse the salvage wording so the
 * resume guidance stays identical.
 */
export function buildStatusReply(
  sessionManager: SessionManager,
  threadId: string
): string {
  if (sessionManager.livenessOf(threadId) === "alive") {
    const row = getSessionByThreadId(threadId);
    const id = row?.claude_session_id;
    return (
      "✅ このスレッドのセッションは稼働中です。\n" +
      (id
        ? `🔑 claude_session_id: \`${id}\``
        : "🔑 claude_session_id: 未記録（#167 導入前に開始されたセッション）")
    );
  }
  // dead / unknown は salvage と同じ案内（resume / start）で十分。
  return buildSalvageReply(sessionManager, threadId);
}
