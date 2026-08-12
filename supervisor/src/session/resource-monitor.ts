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
  /**
   * Poll interval. Defaults to {@link RESOURCE_CHECK_INTERVAL_MS} (30 s).
   * Injectable so a test can drive `start()`/`stop()` without a 30 s wall-clock
   * wait — same seam as {@link import("./reaper").ReaperDeps}.checkIntervalMs.
   */
  checkIntervalMs?: number;
  /**
   * Per-session RSS ceiling in MB. Defaults to {@link
   * MAX_MEMORY_PER_SESSION_MB} (2 GB). Injectable so a test can exercise the
   * over-limit teardown branch against a REAL `ps` reading of a real pid
   * (lowering the ceiling instead of faking the measurement), the same way
   * {@link import("./reaper").ReaperDeps}.idleTimeoutMs makes the reap branch
   * reachable without waiting out the real threshold.
   */
  maxMemoryMb?: number;
}

export class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly admission: AdmissionController;
  private readonly checkIntervalMs: number;
  private readonly maxMemoryMb: number;

  constructor(
    private sessionManager: SessionManager,
    deps: ResourceMonitorDeps = {},
  ) {
    this.admission = deps.admission ?? new AdmissionController();
    this.checkIntervalMs = deps.checkIntervalMs ?? RESOURCE_CHECK_INTERVAL_MS;
    this.maxMemoryMb = deps.maxMemoryMb ?? MAX_MEMORY_PER_SESSION_MB;
  }

  start(): void {
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
    console.log(
      `[ResourceMonitor] Started (check every ${this.checkIntervalMs / 1000}s, limit ${this.maxMemoryMb}MB)`
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
        if (rssMB > this.maxMemoryMb) {
          console.error(
            `[ResourceMonitor] ${session.channelName} (PID ${session.pid}) exceeded memory limit: ${rssMB.toFixed(0)}MB > ${this.maxMemoryMb}MB`
          );
          await this.sessionManager.stop(threadId, "resource_limit");
        }
      } catch {
        // Process might be dead, SessionManager will handle cleanup
      }
    }
  }
}
