import type { ChildProcess } from "child_process";
import type { ContextBudgetTracker } from "./context-budget";

export interface SessionInfo {
  id: string;
  channelName: string;
  threadId: string;
  /** Effective claude cwd: the worktree path when started with a branch, else the channel dir. */
  projectDir: string;
  pid: number;
  process: ChildProcess;
  claudeSessionId?: string;
  startedAt: Date;
  lastActivityAt: Date;
  status: "running" | "stopping";
  /**
   * Branch this session belongs to (Issue #175). Set for both `start` (the
   * worktree branch) and `resume` (carried from the original session row, which
   * runs in the project dir without a worktree). Used to count concurrent
   * same-branch sessions for the thread-title sequence suffix. Undefined when
   * no branch was recorded.
   */
  branch?: string;
  /**
   * Set when the session runs in a per-branch git worktree (Issue #154,
   * `/session start <branch>`). Removed on stop; `mainRepoDir` is the channel
   * repo from which the worktree was created.
   */
  worktree?: { mainRepoDir: string; path: string; branch: string };
  /**
   * Per-session context-budget de-dup tracker (Issue #204). Lazily created on
   * the first relay turn that reports a context token count; held in memory and
   * discarded when the session is removed from the map. Ensures a steady
   * high-context session is warned only when it crosses up into a new band.
   */
  contextBudgetTracker?: ContextBudgetTracker;
}

/**
 * Read-only health snapshot of a single running session (Issue #78, AC-4).
 * Exposed by the Supervisor relay server at `GET /health/sessions` so an E2E
 * harness can decisively verify that a thread maps to the expected tmux session
 * (`claude-<threadId[..12]>`) without shelling into the host. Intentionally
 * minimal: contains no secrets (token, pid, raw process handle) — only the
 * non-sensitive identifiers needed for verification. Dates are ISO-8601 strings
 * so the payload is plain JSON.
 */
export interface SessionHealthInfo {
  threadId: string;
  /** tmux session name as derived by SessionManager (`claude-<threadId[..12]>`). */
  tmuxSession: string;
  channelName: string;
  status: "running" | "stopping";
  startedAt: string;
  lastActivityAt: string;
}

export type StopReason = "manual" | "idle_timeout" | "resource_limit" | "error" | "tmux_exited" | "supervisor_restart" | "self_heal_restart" | "goal_complete";
