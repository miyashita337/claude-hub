import { exec } from "child_process";
import { promisify } from "util";
import type { SessionManager } from "./manager";
import {
  RESOURCE_CHECK_INTERVAL_MS,
  MAX_MEMORY_PER_SESSION_MB,
} from "../config/channels";

const execAsync = promisify(exec);

export class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private sessionManager: SessionManager) {}

  start(): void {
    this.timer = setInterval(
      () => this.check(),
      RESOURCE_CHECK_INTERVAL_MS
    );
    console.log(
      `[ResourceMonitor] Started (check every ${RESOURCE_CHECK_INTERVAL_MS / 1000}s, limit ${MAX_MEMORY_PER_SESSION_MB}MB)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    for (const [threadId, session] of this.sessionManager.entries()) {
      if (!session.pid) continue;
      try {
        const { stdout } = await execAsync(`ps -o rss= -p ${session.pid}`);
        const rssKB = parseInt(stdout.trim(), 10);
        if (isNaN(rssKB)) continue;

        const rssMB = rssKB / 1024;
        if (rssMB > MAX_MEMORY_PER_SESSION_MB) {
          console.error(
            `[ResourceMonitor] ${session.channelName} (PID ${session.pid}) exceeded memory limit: ${rssMB.toFixed(0)}MB > ${MAX_MEMORY_PER_SESSION_MB}MB`
          );
          await this.sessionManager.stop(threadId, "resource_limit");
        }
      } catch {
        // Process might be dead, SessionManager will handle cleanup
      }
    }
  }
}
