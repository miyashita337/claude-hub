import type { SessionManager } from "./manager";
import {
  RESOURCE_CHECK_INTERVAL_MS,
} from "../config/channels";

/**
 * ResourceMonitor — placeholder for -p mode.
 *
 * In the old --channels/tmux mode, this monitored persistent process memory.
 * In -p mode, Claude Code processes are short-lived (per-message), so
 * continuous memory monitoring is less relevant. The monitor interface
 * is preserved for future use (e.g., monitoring Supervisor's own memory).
 */
export class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private sessionManager: SessionManager) {}

  start(): void {
    this.timer = setInterval(
      () => this.check(),
      RESOURCE_CHECK_INTERVAL_MS
    );
    console.log(
      `[ResourceMonitor] Started (check every ${RESOURCE_CHECK_INTERVAL_MS / 1000}s)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    // In -p mode, processes are ephemeral.
    // Monitor Supervisor's own RSS as a health check.
    const rssKB = process.memoryUsage.rss() / 1024;
    const rssMB = rssKB / 1024;
    if (rssMB > 512) {
      console.warn(
        `[ResourceMonitor] Supervisor RSS: ${rssMB.toFixed(0)}MB (high)`
      );
    }
  }
}
