import { exec } from "child_process";
import { promisify } from "util";
import type { SessionManager } from "./manager";
import {
  RESOURCE_CHECK_INTERVAL_MS,
  MAX_MEMORY_PER_SESSION_MB,
} from "../config/channels";
import { AdmissionController } from "./admission";

const execAsync = promisify(exec);

export interface ResourceMonitorDeps {
  /**
   * Admission controller used purely for its load/memory sampling here (Phase 5d
   * / #295): each check() samples system load and logs a WARN when it is high, so
   * saturation episodes are observable in the supervisor log even in the default
   * observe-only mode. The start-time admission GATE lives in bot.ts; this is the
   * periodic observation half. Defaults to a fresh observe-mode controller.
   */
  admission?: AdmissionController;
}

export class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly admission: AdmissionController;

  constructor(
    private sessionManager: SessionManager,
    deps: ResourceMonitorDeps = {},
  ) {
    this.admission = deps.admission ?? new AdmissionController();
  }

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

  /**
   * Sample system load and log a WARN when it is over the ceiling (Phase 5d /
   * #295). Public so a test can drive it deterministically with an injected
   * sampler. Observation only — it never stops or delays anything here (the
   * start-time gate is in bot.ts); this makes high-load episodes visible.
   */
  sampleLoad(): void {
    const decision = this.admission.evaluate();
    if (decision.warn) {
      console.warn(`[ResourceMonitor] ${decision.warn}`);
    }
  }

  async check(): Promise<void> {
    this.sampleLoad();
    // Snapshot first: stop() (resource_limit teardown below) awaits and mutates
    // the live map mid-loop, so iterating the raw entries() iterator while
    // deleting is a race (gemini PR #297 HIGH). Mirrors the reapers.
    for (const [threadId, session] of Array.from(this.sessionManager.entries())) {
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
