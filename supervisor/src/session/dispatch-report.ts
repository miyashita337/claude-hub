/**
 * Dispatch execution report (Epic corp #75 Phase 4 / #289).
 *
 * A headless dispatch run appends this comment to its target Issue when it
 * finishes. The format is a MACHINE-PARSABLE CONTRACT: corp reconcile (corp #76,
 * the opposing implementation) reads the `## Dispatch 実行レポート` heading and
 * the `- key: value` lines to attach token/duration/exit evidence to the
 * dispatch ledger. Keep the heading text and the `- <key>: <value>` shape stable;
 * changing them is a breaking change to that contract.
 *
 *   ## Dispatch 実行レポート
 *
 *   - tokens: <合計 output tokens／取得できなければ行ごと省略>
 *   - duration_ms: <実行時間>
 *   - exit_code: <claude -p の exit code>
 */

export const DISPATCH_REPORT_HEADING = "## Dispatch 実行レポート";

export interface DispatchReportFields {
  /**
   * Total output tokens (`usage.output_tokens` from `claude -p --output-format
   * json`). `null` when it could not be obtained (JSON unparsable / field
   * absent) — the tokens line is then OMITTED entirely rather than guessed
   * (#289: 取得できなければ行ごと省略・捏造しない). `0` is a real value and IS
   * emitted.
   */
  tokens: number | null;
  /** Wall-clock run duration in ms (always present). */
  durationMs: number;
  /** `claude -p` exit code, or `null` when the run was killed (e.g. timeout). */
  exitCode: number | null;
  /**
   * Completion verdict (Issue #342). ADDITIVE to the machine contract: corp
   * reconcile keys off the heading and the existing `- key: value` lines, so
   * appending new keys is backwards-compatible. `clean` runs still emit the
   * line (a reader can distinguish "verified clean" from "predates #342").
   * Optional so callers without a probe (none today) simply omit the lines.
   */
  completion?: "clean" | "pending" | "unknown";
  /** Human-readable pending/unknown evidence; omitted when empty. */
  completionDetail?: string;
  /**
   * Artifact verdict (Issue #342, Layer 2 extension). ADDITIVE like
   * `completion`: `found` runs still emit the line so a reader can distinguish
   * "verified delivery" from "predates the artifact probe". `none` means the
   * run delivered no commit / PR / Issue / comment — a warning even when
   * `completion` is clean. Optional so callers without a probe (non-branch
   * runs) simply omit the lines.
   */
  artifacts?: "found" | "none" | "unknown";
  /** First artifact found / probe errors; omitted when empty. */
  artifactsDetail?: string;
}

/**
 * Render the report body. Deterministic and side-effect-free so a unit test can
 * assert the exact contract (Epic #75 AC-1). The `tokens` line is omitted when
 * {@link DispatchReportFields.tokens} is null; `duration_ms` and `exit_code`
 * are always present (`exit_code` renders `null` verbatim when the run had no
 * numeric exit, so the reader can distinguish a kill/timeout from exit 0).
 */
export function formatDispatchReport(fields: DispatchReportFields): string {
  const lines: string[] = [DISPATCH_REPORT_HEADING, ""];
  if (fields.tokens !== null) {
    lines.push(`- tokens: ${fields.tokens}`);
  }
  lines.push(`- duration_ms: ${fields.durationMs}`);
  lines.push(`- exit_code: ${fields.exitCode === null ? "null" : fields.exitCode}`);
  if (fields.completion) {
    lines.push(`- completion: ${fields.completion}`);
    if (fields.completionDetail) {
      lines.push(`- completion_detail: ${fields.completionDetail}`);
    }
  }
  if (fields.artifacts) {
    lines.push(`- artifacts: ${fields.artifacts}`);
    if (fields.artifactsDetail) {
      lines.push(`- artifacts_detail: ${fields.artifactsDetail}`);
    }
  }
  if (fields.completion && fields.completion !== "clean") {
    lines.push(
      "",
      "⚠️ この run は正常完了と確認できていません（Issue claude-hub#342）。" +
        "worktree は復旧用に保全されています。同じブランチへの再 dispatch で作業状態を引き継げます。",
    );
  }
  if (fields.artifacts && fields.artifacts !== "found") {
    lines.push(
      "",
      "⚠️ この run の成果物（commit / PR / Issue / コメント）を確認できませんでした" +
        `（artifacts: ${fields.artifacts}、Issue claude-hub#342）。作業が実際に行われたか確認してください。`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * A dispatch that failed before any work ran (Issue #438). Emitted on the tmux
 * path when the initial command never reached the pane (`runDispatch`
 * stage=inject, #429), so corp can see the failure where it already reads run
 * evidence (`latestDispatchReport` / `parseDispatchReportLine`, corp#162 /
 * #167) instead of relying on someone noticing a Discord notice.
 */
export interface DispatchFailureReportFields {
  /** Stage the dispatch failed at. Only `inject` is reported (#438 scope). */
  stage: "inject";
  /** Executor backend the dispatch ran on. */
  executor: "tmux";
  branch: string;
  /** The command that was typed but never confirmed, e.g. `/impl 438`. */
  initialCommand: string;
  /** Whether the started-but-idle session was torn down (#429 should-4). */
  sessionStopped: boolean;
}

/**
 * Render the failure report. Same heading and `- key: value` shape as
 * {@link formatDispatchReport}; the keys are NEW so the contract stays
 * additive: none of `tokens` / `duration_ms` / `exit_code` / `completion` /
 * `artifacts` is emitted, which keeps corp's existing reconcile predicates
 * (`isEmptyRun`, `isUnlandedCandidate`) from judging a run that never happened.
 *
 * The raw failure cause is deliberately NOT included: it can carry tmux
 * internals or absolute paths (same rule as the Discord notice,
 * `buildDispatchFailureNotice`). Diagnostics stay in the Supervisor log.
 */
export function formatDispatchFailureReport(
  fields: DispatchFailureReportFields,
): string {
  const lines = [
    DISPATCH_REPORT_HEADING,
    "",
    `- dispatch_failure: ${fields.stage}`,
    `- executor: ${fields.executor}`,
    `- branch: ${fields.branch}`,
    `- initial_command: ${fields.initialCommand}`,
    `- session_stopped: ${fields.sessionStopped}`,
    "",
    "⚠️ 初期コマンドがセッションに届いたことを確認できず、dispatch は失敗しました（claude-hub#429 / #438）。" +
      "二重実行を避けるため自動での再入力はしていません。再投入が必要です。",
  ];
  if (!fields.sessionStopped) {
    lines.push(
      "",
      "⚠️ セッションの停止にも失敗しています。残存セッションがないか確認してください。",
    );
  }
  return lines.join("\n") + "\n";
}
