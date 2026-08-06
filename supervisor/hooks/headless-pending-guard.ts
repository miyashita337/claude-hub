#!/usr/bin/env bun
/**
 * Stop hook: keep a headless dispatch worker alive while it still has pending
 * background work (Issue #342, Layer 1 / prevention).
 *
 * A `claude -p` worker exits at turn end, killing any in-flight background
 * task and orphaning any ScheduleWakeup reservation — observed live as
 * exit-0 / no-PR silent failures (#338, agent-base#456). Prompt-level rules
 * alone were proven insufficient (#456 was dispatched WITH an explicit
 * "finish in one turn" instruction and still went to the background via a
 * foreground timeout it did not recognise as one).
 *
 * This hook is injected ONLY into headless dispatch children via `--settings`
 * (see `buildPendingGuardFlags` in `src/session/manager.ts`); interactive and
 * tmux sessions never load it. On each Stop event it parses the session
 * transcript with the shared deterministic detector (`pending-work.ts`) and,
 * while pending work remains, answers `{"decision":"block"}` so the harness
 * gives the worker another turn with concrete instructions to finish the
 * wait synchronously. Empirically verified under `claude -p`: the Stop hook
 * fires, `decision:block` forces continuation, and `stop_hook_active` is set
 * on the follow-up Stop (real runs, 2026-08-06).
 *
 * Fail-safe posture:
 *   - Bounded: at most HEADLESS_PENDING_GUARD_MAX_BLOCKS (default 20) blocks
 *     per session (counter file in the OS tmpdir), so a worker that cannot
 *     drain its work is eventually allowed to stop — Layer 2
 *     (`manager.runHeadless`'s completion probe) then reports it as pending
 *     instead of clean, and the worktree is retained.
 *   - Internal failures (unreadable transcript, bad stdin) allow the stop and
 *     log to stderr; they never wedge the worker. Layer 2 independently
 *     reports `completion: unknown` for an unreadable transcript, so this
 *     hook degrading is loud downstream, not silent (review condition 3).
 *   - Kill switch: HEADLESS_PENDING_GUARD=off disables blocking entirely.
 */

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  probePendingWork,
  describePendingWork,
} from "../src/session/pending-work";

const DEFAULT_MAX_BLOCKS = 20;

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

function counterPath(sessionId: string): string {
  // sessionId is a UUID we pinned ourselves (`--session-id`), but sanitise
  // anyway so a hostile value cannot traverse out of the tmpdir.
  const safe = sessionId.replace(/[^A-Za-z0-9-]/g, "_");
  return join(tmpdir(), `headless-pending-guard-${safe}.blocks`);
}

function readCount(path: string): number {
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function main(): void {
  if (process.env.HEADLESS_PENDING_GUARD === "off") {
    return; // kill switch: allow every stop
  }

  let input: StopHookInput;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as StopHookInput;
  } catch (err) {
    console.error(`[headless-pending-guard] stdin unparsable, allowing stop: ${err}`);
    return;
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) {
    console.error(
      "[headless-pending-guard] missing session_id/transcript_path, allowing stop",
    );
    return;
  }

  const probe = probePendingWork(transcriptPath);
  if (!probe.ok) {
    // Fail-loud downstream: Layer 2 reports `completion: unknown` for this.
    console.error(
      `[headless-pending-guard] ${probe.error} — allowing stop (Layer 2 will flag the run)`,
    );
    return;
  }

  const work = probe.value;
  const hasPending = work.pendingTasks.length > 0 || work.pendingWakeup;
  const counter = counterPath(sessionId);

  if (!hasPending) {
    try {
      unlinkSync(counter); // housekeeping; absence is fine
    } catch {
      /* counter never existed — nothing to clean */
    }
    return;
  }

  const maxBlocks = (() => {
    const n = Number.parseInt(process.env.HEADLESS_PENDING_GUARD_MAX_BLOCKS ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BLOCKS;
  })();
  const blocks = readCount(counter);
  if (blocks >= maxBlocks) {
    console.error(
      `[headless-pending-guard] pending work remains after ${blocks} blocks — ` +
        `allowing stop; Layer 2 will report it (${describePendingWork(work)})`,
    );
    return;
  }

  try {
    writeFileSync(counter, String(blocks + 1), "utf8");
  } catch (err) {
    // Without a counter the bound cannot be enforced — allow the stop rather
    // than risk an unbounded block loop.
    console.error(`[headless-pending-guard] counter write failed, allowing stop: ${err}`);
    return;
  }

  const reason =
    `この実行は headless（claude -p）のため、turn を終了するとプロセスごと終了し、` +
    `背景タスクと ScheduleWakeup 予約は失われます（Issue claude-hub#342 の silent failure）。\n` +
    `検出された未完了: ${describePendingWork(work)}\n\n` +
    `対応してから終了してください:\n` +
    `- 背景タスク: TaskOutput(task_id, block=true) で完了まで同期的に待つか、` +
    `出力ファイルを Read で確認しながら完了を待つ（10 分を超える待ちは短い確認を繰り返す）\n` +
    `- ScheduleWakeup: stop:true で解除し、待ち時間は同期ポーリングで消化する\n` +
    `- すべて完了・回収したら、成果（commit / push / PR / Issue コメント）まで仕上げて終了する`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

main();
