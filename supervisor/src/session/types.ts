import type { ChildProcess } from "child_process";

export interface SessionInfo {
  id: string;
  channelName: string;
  threadId: string;
  projectDir: string;
  pid: number;
  process: ChildProcess;
  claudeSessionId?: string;
  startedAt: Date;
  lastActivityAt: Date;
  status: "running" | "stopping";
}

export type StopReason = "manual" | "idle_timeout" | "resource_limit" | "error";
