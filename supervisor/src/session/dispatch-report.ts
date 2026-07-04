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
  return lines.join("\n") + "\n";
}
