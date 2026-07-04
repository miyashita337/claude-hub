import { cpus, loadavg, freemem, totalmem } from "os";
import {
  ADMISSION_LOAD_FACTOR,
  ADMISSION_DELAY_MS,
} from "../config/channels";

/**
 * Dynamic admission control (Phase 5d / #295, Epic #292). Samples system load and
 * decides whether a NEW session start should be delayed under high load.
 *
 * WARN-FIRST (thin-scaffolding dogfood): the default mode is OBSERVE — it logs a
 * WARN when load is high but never delays (delayMs = 0). Enforcement (an actual
 * delay) is opt-in via `DISPATCH_ADMISSION_ENFORCE=1`, to be flipped on only
 * after a few days of zero-false-positive observation. It NEVER rejects a start —
 * the worst it does is delay, so a dispatch is never dropped by admission.
 *
 * Retreat criteria (documented in docs/bot-operations.md): if the Phase 5c FIFO
 * queue alone resolves the timeout問題, admission enforcement is never enabled and
 * this stays observe-only (YAGNI).
 */

/** A point-in-time system load/memory sample. Injectable so tests never read real os metrics. */
export interface SystemSample {
  /** 1-minute load average. */
  load1: number;
  /** Number of logical CPUs. */
  cores: number;
  /** Free memory ratio in [0,1] (freemem/totalmem); lower = more pressure. */
  freeMemRatio: number;
}

export interface LoadSampler {
  sample(): SystemSample;
}

/** Real sampler over `os` (cross-platform: loadavg is 0 on unsupported platforms). */
export const realLoadSampler: LoadSampler = {
  sample(): SystemSample {
    const total = totalmem();
    return {
      load1: loadavg()[0] ?? 0,
      cores: Math.max(1, cpus().length),
      freeMemRatio: total > 0 ? freemem() / total : 1,
    };
  },
};

export type AdmissionMode = "observe" | "enforce";

/**
 * Resolve the admission mode from the environment (#295). WARN-first: anything
 * other than the exact opt-in `DISPATCH_ADMISSION_ENFORCE=1` resolves to
 * "observe" (log-only, no delay), so the default is safe.
 */
export function resolveAdmissionMode(
  env: Record<string, string | undefined> = process.env,
): AdmissionMode {
  return env.DISPATCH_ADMISSION_ENFORCE === "1" ? "enforce" : "observe";
}

/** Decision from {@link AdmissionController.evaluate}. Pure data — the caller logs/sleeps. */
export interface AdmissionDecision {
  /** ms the caller should wait before starting. Always 0 in observe mode. */
  delayMs: number;
  /** A WARN message to log when load is high, else null. */
  warn: string | null;
  /** The sample the decision was based on (for structured logging). */
  sample: SystemSample;
}

export interface AdmissionControllerDeps {
  sampler?: LoadSampler;
  mode?: AdmissionMode;
  /** Load ceiling factor: high when load1 > cores * factor. Defaults to {@link ADMISSION_LOAD_FACTOR}. */
  loadFactor?: number;
  /** Delay applied in enforce mode when over the ceiling. Defaults to {@link ADMISSION_DELAY_MS}. */
  delayMs?: number;
}

export class AdmissionController {
  private readonly sampler: LoadSampler;
  private readonly mode: AdmissionMode;
  private readonly loadFactor: number;
  private readonly delayMs: number;

  constructor(deps: AdmissionControllerDeps = {}) {
    this.sampler = deps.sampler ?? realLoadSampler;
    this.mode = deps.mode ?? resolveAdmissionMode();
    this.loadFactor = deps.loadFactor ?? ADMISSION_LOAD_FACTOR;
    this.delayMs = deps.delayMs ?? ADMISSION_DELAY_MS;
  }

  /**
   * Evaluate whether a new start should be delayed. Side-effect-free (samples
   * only), so tests assert the decision deterministically:
   *   - load ≤ ceiling                 → { delayMs: 0, warn: null }
   *   - load > ceiling, observe (default) → { delayMs: 0, warn: "…" }  (WARN-first, AC-5)
   *   - load > ceiling, enforce        → { delayMs: N, warn: "…" }     (AC-4)
   */
  evaluate(): AdmissionDecision {
    const sample = this.sampler.sample();
    const ceiling = sample.cores * this.loadFactor;
    if (sample.load1 <= ceiling) {
      return { delayMs: 0, warn: null, sample };
    }
    const warn =
      `[Admission] high load: load1=${sample.load1.toFixed(2)} > ceiling ${ceiling.toFixed(2)} ` +
      `(cores=${sample.cores}, freeMem=${(sample.freeMemRatio * 100).toFixed(0)}%), mode=${this.mode}` +
      (this.mode === "observe"
        ? " — observe only (no delay)"
        : ` — delaying start by ${this.delayMs}ms`);
    return {
      delayMs: this.mode === "enforce" ? this.delayMs : 0,
      warn,
      sample,
    };
  }

  /**
   * Convenience gate used before a real start: evaluate, log the WARN if any, and
   * (enforce mode only) wait `delayMs`. Returns the decision so callers can also
   * record it. `sleep` is injectable so tests never wait real time.
   */
  async gate(
    log: Pick<Console, "warn"> = console,
    sleep: (ms: number) => Promise<void> = defaultSleep,
  ): Promise<AdmissionDecision> {
    const decision = this.evaluate();
    if (decision.warn) log.warn(decision.warn);
    if (decision.delayMs > 0) await sleep(decision.delayMs);
    return decision;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
