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
    if (fields.completion !== "clean") {
      lines.push(
        "",
        "⚠️ この run は正常完了と確認できていません（Issue claude-hub#342）。" +
          "worktree は復旧用に保全されています。同じブランチへの再 dispatch で作業状態を引き継げます。",
      );
    }
  }
  return lines.join("\n") + "\n";
}
