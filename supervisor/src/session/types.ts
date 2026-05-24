import type { ChildProcess } from "child_process";

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
   * Set when the session runs in a per-branch git worktree (Issue #154,
   * `/session start <branch>`). Removed on stop; `mainRepoDir` is the channel
   * repo from which the worktree was created.
   */
  worktree?: { mainRepoDir: string; path: string; branch: string };
}

export type StopReason = "manual" | "idle_timeout" | "resource_limit" | "error" | "tmux_exited" | "supervisor_restart";
