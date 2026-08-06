import { randomUUID } from "crypto";
import { existsSync, unlinkSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import type { SessionInfo, SessionHealthInfo, StopReason } from "./types";
import type { ChannelConfig } from "../config/channels";
import {
  MAX_SESSIONS,
  GRACEFUL_KILL_TIMEOUT_MS,
} from "../config/channels";
import {
  insertSession,
  updateSessionStatus,
  updateSessionActivity,
  getRunningSessions,
  getSessionByClaudeSessionId,
  getSessionByThreadId,
  type SessionRow,
} from "../infra/db";
import {
  relayMessage,
  sendToPane,
  type AttachmentInfo,
  type RelayResult,
  type RelayMessageOptions,
} from "./relay";
import {
  realSessionEffects,
  type SessionEffects,
  type HeadlessRunResult,
} from "./adapters";
import {
  createContextBudgetTracker,
  type ContextBudgetLevel,
  type ContextBudgetWarning,
} from "./context-budget";
import {
  createSelfHealer,
  type SelfHealAction,
  type SelfHealer,
} from "./self-heal";
import { compactClaudeHubExit } from "./primary-compact";
import { formatDispatchReport } from "./dispatch-report";
import {
  deriveTranscriptPath,
  describePendingWork,
  probePendingWork,
  type PendingWorkProbe,
} from "./pending-work";

const DEFAULT_CLAUDE_PATH = resolve(homedir(), ".local", "bin", "claude");
const TMUX_SESSION_PREFIX = "claude-";

/**
 * Resolve the `claude` executable path at use-time (not module-load-time) so the
 * lifecycle E2E (Issue #144/#273) can point it at `fixtures/claude-mock.sh` via
 * `SUPERVISOR_CLAUDE_PATH` set on the `bun test` process. `SUPERVISOR_CLAUDE_PATH`
 * is operator-controlled (same trust level as `SUPERVISOR_TMUX_SOCKET`); callers
 * embed the result quoted in the tmux command line so paths with spaces are safe.
 */
function claudePath(): string {
  const envPath = process.env.SUPERVISOR_CLAUDE_PATH;
  return envPath && envPath.length > 0 ? resolve(envPath) : DEFAULT_CLAUDE_PATH;
}

/**
 * Non-empty intent for an auto-compact (Issue #206). RW-032: a bare `/compact`
 * produces a bad compact, so the auto path — like the manual command — always
 * carries an intent that preserves the working state and names the trigger.
 */
export const AUTO_COMPACT_INTENT =
  "コンテキスト肥大化による tool 破損を回避するため直近の作業状態と次アクションを保持して自動圧縮 (#206)";

/**
 * Outcome of a self-heal evaluation (Issue #206). `message` is ready to post to
 * the Discord thread (it already reflects whatever auto-action was taken), and
 * `page` marks red/critical so the caller pages Pushover. Returned only when the
 * session crossed up into a new band; null otherwise (no spam).
 */
export interface SelfHealOutcome {
  level: ContextBudgetLevel;
  action: SelfHealAction;
  message: string;
  tokens: number;
  /** True for red/critical → caller should page Pushover. */
  page: boolean;
  /**
   * Present only when {@link action} is `"restart"` (Issue #244). The manager
   * cannot create a Discord thread, so it hands the caller (bot.ts) everything
   * the resume-backed restart needs, captured BEFORE the old session is stopped.
   * `claudeSessionId` is guaranteed non-empty here (the restart branch downgrades
   * to `"notify"` when it is missing), so the caller can always build a valid
   * `/session resume <id>` even on the degrade path.
   */
  restart?: {
    claudeSessionId: string;
    channelName: string;
    projectDir: string;
    branch: string | null;
  };
}

/**
 * Authoritative liveness verdict produced by {@link SessionManager.livenessOf}
 * (Issue #168). Single source of truth so salvage responses and resume guards
 * do not drift.
 *   - `alive`: DB running + pid alive + tmux session exists
 *   - `dead`: DB stopped, OR DB running but pid dead / tmux missing
 *   - `unknown`: no DB row for the thread (never observed)
 */
export type Liveness = "alive" | "dead" | "unknown";

/**
 * Claude session IDs are UUIDs. The resume flow embeds the id in the bash
 * command string passed to tmux, so restrict it to the UUID shape — a value
 * that fails this cannot carry shell metacharacters (Issue #161).
 */
const CLAUDE_SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Marker for Claude Code's interactive resume prompt
 * (`Resume from summary (recommended)` / `Resume the full conversation`),
 * shown when `claude --resume <id>` targets a compacted session. There is no
 * CLI flag to pre-select it (`claude --help`), so the resume flow polls the
 * pane for this marker and sends Enter (Issue #161).
 */
const RESUME_PROMPT_RE = /Resume (from summary|the full conversation)/i;
/**
 * Marker that the resumed TUI reached its normal input prompt — either a
 * non-compacted session that never shows the picker, or the picker has already
 * been dismissed. Lets the poll loop stop early instead of waiting out the full
 * window when there is nothing to confirm (Issue #163).
 */
const RESUME_READY_RE = /bypass permissions|\? for shortcuts/i;
/**
 * Poll attempts (×interval) to detect the resume prompt before giving up.
 * Large compacted sessions can take minutes to render the picker (observed
 * ~4min for a 239k-token / 1d21h session), so with the default 1s interval this
 * is a ~5min budget. The loop exits early as soon as the picker OR the ready
 * marker appears, so a small/non-compacted resume still returns in ~1s
 * (Issue #163 — a 12×0.5s=6s window timed out before the picker rendered).
 */
const RESUME_PROMPT_POLL_ATTEMPTS = 300;

/**
 * Input-ready marker for a freshly STARTED session's Ink TUI (same prompt
 * markers as {@link RESUME_READY_RE}; a `--dangerously-skip-permissions` session
 * shows the "bypass permissions" banner + "? for shortcuts" hint once it can
 * accept input). The dispatch transport (dispatch.ts) waits for this before
 * injecting `/impl <N>` so the slash-command picker doesn't swallow the leading
 * `/` while the TUI is still booting (CLAUDE.md / skills / MCP) and strand the
 * text un-submitted (RW-025 / RW-027 / RW-047 timing class).
 */
const INPUT_READY_RE = /bypass permissions|\? for shortcuts/i;
/**
 * Poll attempts (×interval) to detect the input-ready marker before giving up.
 * A fresh dispatch session (mcpProfile "none") boots in ~5-15s; 60×1s = 60s is a
 * generous ceiling. On timeout the caller injects anyway (best-effort) — the
 * marker may have scrolled off, and by then the TUI is almost certainly ready.
 */
const INPUT_READY_POLL_ATTEMPTS = 60;

/**
 * Build the argv for the `claude` invocation in a supervisor session.
 *
 * Issue #104 / Epic #101: by default supervisor sessions disable Chrome
 * integration and skip every user-scope MCP server, reclaiming 10-15s of
 * cold-start that nothing in the relay path needs. The flags here can be
 * relaxed per channel via {@link ChannelConfig.chromeEnabled} and
 * {@link ChannelConfig.mcpProfile}.
 *
 * Returned tokens are joined with single-space and embedded in a bash command
 * string downstream; callers must not append shell metacharacters that would
 * not survive that round-trip. Single-quoted JSON for `--mcp-config` is safe
 * because bash treats it as a single literal argument.
 */
/**
 * Character-safety gate for a `/session start` model override (#303).
 *
 * This is NOT a model allowlist: it deliberately accepts any id/alias whose
 * characters are shell-inert, so `claude-bogus` passes here and is later
 * rejected by `claude` with a non-zero exit (the #298 no-silent-fallback
 * contract). Its sole job is to reject shell metacharacters at the Discord
 * boundary so a value like `x; rm -rf ~` can never reach the tmux bash command
 * string. Every real id/alias matches: `fable`, `opus`, `sonnet`, `haiku`,
 * `claude-fable-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`.
 */
export function isValidModelId(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model);
}

/**
 * POSIX single-quote a value for safe embedding in the tmux bash *command
 * string* (buildClaudeFlags tokens are space-joined into a bash line — see the
 * buildClaudeFlags contract above). Single quotes disable every shell expansion;
 * an embedded `'` is closed, escaped, and reopened (`'\''`). Defense-in-depth:
 * even if a caller skips {@link isValidModelId}, the value cannot break out.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildClaudeFlags(
  config: ChannelConfig,
  model?: string,
): string[] {
  const args = [
    "--dangerously-skip-permissions",
    "--name",
    `"${config.channelName}"`,
  ];

  if (config.chromeEnabled !== true) {
    args.push("--no-chrome");
  }

  const profile = config.mcpProfile ?? "none";
  if (profile === "none") {
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      `'{"mcpServers":{}}'`,
    );
  }

  // #303: pin the model only when explicitly requested via `/session start`.
  // Absent → no `--model`, environment default (behaviour unchanged; mirrors
  // buildHeadlessClaudeFlags / #298). Unlike the headless argv path, these
  // tokens are embedded in the tmux bash command string, so the value is
  // single-quoted. `--model <model>` verified against `claude --help` (v2.1.201).
  const trimmedModel = model?.trim();
  if (trimmedModel) {
    args.push("--model", shellSingleQuote(trimmedModel));
  }

  return args;
}

/**
 * Default wall-clock ceiling for a headless `claude -p` run (Epic #285 Phase 2).
 * A dispatch job (`/impl`, `/pdca`) can legitimately run for many minutes, so
 * this is generous; it exists to bound a genuinely wedged child so it cannot
 * squat a MAX_SESSIONS slot forever (the "誤放置" half of #288). The idle
 * reapers deliberately do NOT reap headless sessions — a self-terminating child
 * with its own timeout is the authoritative liveness bound, not tmux idle time —
 * so this ceiling is that bound. Env-overridable for ops tuning (mirrors
 * DISPATCH_ORPHAN_IDLE_MS) without a redeploy.
 */
export const HEADLESS_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

function headlessTimeoutMs(): number {
  const raw = process.env.DISPATCH_HEADLESS_TIMEOUT_MS;
  if (!raw) return HEADLESS_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HEADLESS_TIMEOUT_MS;
}

/**
 * Build the argv for a headless `claude -p` run (Epic #285 Phase 2 / #286).
 *
 * This intentionally does NOT reuse {@link buildClaudeFlags}: that helper
 * pre-quotes its values for embedding in the tmux path's bash *command string*
 * (e.g. `--name "channel"` and `--mcp-config '{...}'` carry literal quotes so a
 * shell round-trip parses them correctly). Headless spawns with an argv *array*
 * and no shell (Bun.spawn), so those literal quotes would become part of the
 * value — `--mcp-config '{"mcpServers":{}}'` would be an invalid config path.
 * Here every token is a clean, unquoted argv element.
 *
 * Reuses the same config-driven decisions as buildClaudeFlags (chromeEnabled,
 * mcpProfile) but drops `--name`, whose only effect is the Ink TUI display name
 * (TUI-only, per #286). Flags verified against `claude --help` (v2.1.201):
 * `-p`/`--print`, `--output-format`, `--dangerously-skip-permissions`,
 * `--no-chrome`, `--strict-mcp-config`, `--mcp-config`, `--session-id`.
 *
 * `initialCommand` is the first prompt (e.g. `/impl 42`) — a fixed literal built
 * from the validated selector + issue number, never free user text.
 */
/**
 * Resolve the dispatch model override (corp #81 Phase 6 / #298). Returns the
 * trimmed `DISPATCH_CLAUDE_MODEL` value, or undefined when unset / blank /
 * whitespace-only (all treated as "no override" → the environment's default
 * model, current behaviour). No validation of the id here: an invalid model is
 * surfaced by the run's non-zero exit (posted to the thread), NOT silently fixed
 * up (#298 — no silent fallback).
 */
export function resolveDispatchModel(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const trimmed = env.DISPATCH_CLAUDE_MODEL?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildHeadlessClaudeFlags(
  config: ChannelConfig,
  initialCommand: string,
  model?: string,
): string[] {
  const args = [
    "-p",
    initialCommand,
    // JSON so the run's usage is machine-readable (Epic #75 Phase 4 / #289):
    // the final envelope carries `usage.output_tokens` for the dispatch report
    // and `result` (the final text) for the thread. Verified against a real
    // `claude -p --output-format json` run (v2.1.201): top-level `result`,
    // `duration_ms`, and `usage.{input,output}_tokens`.
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];

  if (config.chromeEnabled !== true) {
    args.push("--no-chrome");
  }

  const profile = config.mcpProfile ?? "none";
  if (profile === "none") {
    // Raw JSON (no surrounding quotes): argv is passed literally, no shell.
    args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  }

  // corp #81 Phase 6 (#298): pin the model only when explicitly requested. Absent
  // → no `--model`, so the environment default is used (behaviour unchanged).
  // `--model <model>` verified against `claude --help` (v2.1.201). Trim guards a
  // whitespace-only value passed directly.
  const trimmedModel = model?.trim();
  if (trimmedModel) {
    args.push("--model", trimmedModel);
  }

  return args;
}

/**
 * Absolute path to the Stop hook that keeps a headless worker alive while it
 * still has pending background work (Issue #342, Layer 1). Resolved from this
 * module's location so it always points at the checkout the Supervisor is
 * actually running from (main or a worktree).
 */
const PENDING_GUARD_HOOK_PATH = fileURLToPath(
  new URL("../../hooks/headless-pending-guard.ts", import.meta.url),
);

/**
 * Build the `--settings` flag that injects the pending-work Stop hook into a
 * headless child (Issue #342). Scoped injection: only headless dispatch
 * children receive the hook — interactive/tmux sessions and the user's own
 * settings are untouched. `--settings <json>` and Stop-hook `decision:block`
 * under `claude -p` were both verified against real runs (v2.x, 2026-08-06).
 *
 * Kill switch: `HEADLESS_PENDING_GUARD=off` disables the injection entirely
 * (the hook script honours the same variable as a second layer). The hook is
 * run with the same bun binary that runs the Supervisor (`process.execPath`)
 * so no PATH assumption leaks into the child.
 */
export function buildPendingGuardFlags(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.HEADLESS_PENDING_GUARD === "off") return [];
  const settings = {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `"${process.execPath}" "${PENDING_GUARD_HOOK_PATH}"`,
            },
          ],
        },
      ],
    },
  };
  return ["--settings", JSON.stringify(settings)];
}

/**
 * Completion verdict for a finished headless run (Issue #342, Layer 2).
 *
 *   - `clean`:   no pending signal — safe to reclaim the worktree.
 *   - `pending`: the child left work in flight (surviving process-group
 *                members, unfinished background tasks, or an unfired
 *                ScheduleWakeup). The run is NOT a success even on exit 0.
 *   - `unknown`: the transcript could not be read/parsed, so completion could
 *                not be verified. Deliberately NOT folded into `clean`
 *                (fail-loud): treating "could not check" as "checked OK" would
 *                re-create the silent failure this exists to remove.
 */
export type HeadlessCompletionStatus = "clean" | "pending" | "unknown";

export interface HeadlessCompletion {
  status: HeadlessCompletionStatus;
  /** Human-readable evidence (pending task ids / probe error), "" when clean. */
  detail: string;
}

/**
 * Environment for a headless child (Epic #285 Phase 2). Bun.spawn REPLACES the
 * environment, so this returns a COMPLETE env derived from the supervisor's:
 *   - ANTHROPIC_API_KEY removed → use the Claude Max subscription (mirrors the
 *     tmux path's `unset ANTHROPIC_API_KEY`),
 *   - PATH prefixed with the same dirs the tmux path exports, so tools the run
 *     shells out to (git / gh / bun) resolve regardless of the supervisor's PATH.
 * SUPERVISOR_RELAY_URL is intentionally NOT set: headless captures stdout
 * directly, so the PostToolUse progress-relay hook has nothing to POST to.
 */
function buildHeadlessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const extraPath = [
    resolve(homedir(), ".local/bin"),
    resolve(homedir(), ".bun/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  env.PATH = env.PATH ? `${extraPath}:${env.PATH}` : extraPath;
  return env;
}

/** Outcome of {@link SessionManager.runHeadless}. */
export interface HeadlessSessionResult {
  /** `claude -p` exit code, or null when killed (e.g. timeout). */
  exitCode: number | null;
  /**
   * Presentable text: the parsed `result` field of the JSON envelope, or the raw
   * stdout when the envelope could not be parsed (crash / timeout before it was
   * emitted). This is what the dispatch thread shows — never the raw JSON.
   */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Wall-clock run duration in ms (always present). */
  durationMs: number;
  /**
   * Total output tokens (`usage.output_tokens`), or null when unobtainable
   * (JSON unparsable / field absent). The dispatch report omits the tokens line
   * when null rather than guessing (#289).
   */
  tokens: number | null;
  /** Supervisor session-row id (for correlating with sessions.db). */
  sessionId: string;
  /** The pinned `--session-id` value handed to the child. */
  claudeSessionId: string;
  /** Completion verdict (Issue #342): pending/unknown runs are not successes. */
  completion: HeadlessCompletion;
}

/**
 * Parse the `claude -p --output-format json` envelope (Epic #75 Phase 4 / #289).
 * Fail-soft: on any parse failure (empty / partial / non-JSON — e.g. a crash or
 * timeout before the envelope was written) it returns the raw output as the
 * presentable text and null tokens, never throwing and never fabricating a token
 * count. Field names verified against a real run (v2.1.201): top-level `result`,
 * `usage.output_tokens`.
 */
export function parseHeadlessOutput(raw: string): {
  text: string;
  tokens: number | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { text: "", tokens: null };
  try {
    const obj = JSON.parse(trimmed) as {
      result?: unknown;
      usage?: { output_tokens?: unknown };
    };
    const text = typeof obj.result === "string" ? obj.result : raw;
    const ot = obj.usage?.output_tokens;
    const tokens = typeof ot === "number" && Number.isFinite(ot) ? ot : null;
    return { text, tokens };
  } catch {
    return { text: raw, tokens: null };
  }
}

/**
 * Compute the runtime-dir path that holds the relay URL for a given project
 * cwd. Sanitises by stripping every leading `/` and replacing any character
 * outside `[A-Za-z0-9._-]` with `_`, so each session's URL lives in its own
 * file and the path is shell-safe even if `projectDir` contains quotes:
 *
 *   /Users/x/team_salary  →  ${RUNTIME_DIR}/Users_x_team_salary.relay-url
 *
 * `XDG_RUNTIME_DIR` is per-user by spec (`/run/user/$UID`), so when present
 * we just append `claude-hub-supervisor`. When absent (typical macOS) we fall
 * back to `/tmp/claude-hub-supervisor-<USER>` to avoid multi-user mkdir
 * collisions on shared `/tmp`.
 *
 * The same scheme is mirrored in `supervisor/hooks/progress-relay.sh`. If you
 * change the layout here, update the hook and its tests as well.
 *
 * Issue #88: keeps the file out of every project repo.
 */
export function relayUrlFilePath(projectDir: string): string {
  const fromXdg = process.env.XDG_RUNTIME_DIR;
  const user = process.env.USER || "default";
  const runtimeDir = fromXdg
    ? `${fromXdg}/claude-hub-supervisor`
    : `/tmp/claude-hub-supervisor-${user}`;
  const sanitised = projectDir
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return `${runtimeDir}/${sanitised}.relay-url`;
}

export interface SessionManagerOptions {
  /**
   * Inject side-effect adapters for tmux / iTerm2 / relay-server / process
   * signals. Tests pass fakes from {@link ./adapters-fake} so unit tests do
   * not spawn real tmux sessions or iTerm2 tabs (Issue #61). Production
   * leaves this undefined to use {@link realSessionEffects}.
   */
  effects?: Partial<SessionEffects>;
  /**
   * Override the graceful-kill wait so tests don't pay the production 15s
   * delay before kill-session. Defaults to {@link GRACEFUL_KILL_TIMEOUT_MS}.
   */
  gracefulKillTimeoutMs?: number;
  /**
   * Resume-prompt poll tuning (Issue #161). Tests shrink these so the
   * "no prompt" path doesn't pay the production ~6s wait. Defaults:
   * {@link RESUME_PROMPT_POLL_ATTEMPTS} attempts × 500ms.
   */
  resumePromptPollAttempts?: number;
  resumePromptPollIntervalMs?: number;
  /**
   * Input-ready poll tuning for {@link SessionManager.waitForInputReady} (the
   * dispatch readiness wait). Tests shrink these so they don't pay the
   * production wait. Defaults: {@link INPUT_READY_POLL_ATTEMPTS} attempts × 1s.
   */
  inputReadyPollAttempts?: number;
  inputReadyPollIntervalMs?: number;
  /**
   * Override the {@link SessionManager.watchTmuxSession} poll interval. Tests
   * shrink this (e.g. to a few ms) to drive the async re-entry guard
   * deterministically without waiting the production 10s (Issue #227 PR-3).
   * Defaults to 10_000.
   */
  watchIntervalMs?: number;
  /**
   * Test seam for the headless completion probe (Issue #342): overrides the
   * transcript read+parse (`probePendingWork`) so unit tests control the
   * pending verdict without writing real files under `~/.claude/projects`.
   * Production leaves this undefined.
   */
  probePendingWorkFn?: (transcriptPath: string) => PendingWorkProbe;
}

/**
 * A compact was requested for a thread that already has one in flight (#364).
 * Distinct from a generic failure so the command layer can say "already running"
 * instead of "❌ 送信に失敗" — nothing went wrong, the first one is still going.
 */
export class CompactInFlightError extends Error {
  constructor(public readonly threadId: string) {
    super(`compact は既にこのスレッドで実行中です (thread ${threadId})`);
    this.name = "CompactInFlightError";
  }
}

export class SessionManager {
  /** Map<threadId, SessionInfo> — one session per thread */
  private sessions = new Map<string, SessionInfo>();
  /** Map<threadId, intervalHandle> — watchdogs to clear on stop/shutdown */
  private watchers = new Map<string, ReturnType<typeof setInterval>>();
  /**
   * Thread ids with an in-flight {@link compactSession} (Issue #364). `/compact`
   * is relayed as a multi-step `sendToPane` sequence (Escape → literal → Enter);
   * two overlapping sends interleave into the SAME pane and can leave a partial
   * command in the TUI. A slash command is hard to fire twice in the same
   * instant, but a button stays clickable after the click — so this became a
   * reachable race the moment the compact button was added.
   */
  private compactInFlight = new Set<string>();
  /**
   * Map<claudeSessionId, SelfHealer> — the per-CONVERSATION self-heal planner
   * (Issue #206/#244). Keyed by claude session id, NOT threadId, so the
   * auto-action cap survives a self-heal restart: a critical restart stops the
   * old session and `claude --resume`s the SAME id into a fresh thread, which
   * reloads the full ~800k context and would re-cross critical immediately. A
   * fresh per-thread planner would reset the cap and restart forever (RW-043);
   * keying by claude session id makes compacts AND restarts share ONE bounded
   * budget across the whole conversation's restart chain (AC item 2). Entries
   * are removed on a terminal stop / tmux exit (but NOT on a self_heal_restart
   * stop, which must carry the count forward to the resumed session).
   */
  private readonly selfHealers = new Map<string, SelfHealer>();
  /**
   * threadIds with a start currently in flight (review #185 gemini HIGH).
   * Since {@link start} is async (it awaits the PID poll), the dup-check and
   * MAX_SESSIONS guard could otherwise be bypassed by a second concurrent
   * start() interleaving at the await before the first reaches
   * `this.sessions.set`. Registered synchronously before any await and released
   * in `finally`, so on the single-threaded event loop a racing start of the
   * same thread — or one that would exceed MAX_SESSIONS — is rejected
   * deterministically (TOCTOU; mirrors resumeSession's single-flight lock).
   */
  private readonly pendingStarts = new Set<string>();
  /**
   * claude_session_ids with a resume currently in flight (Issue #171, 穴 C).
   * Acquired synchronously at the top of {@link resumeSession} and released in
   * its `finally`, so on the single-threaded event loop a second near-
   * simultaneous resume of the SAME id observes the lock and is rejected before
   * it can launch a duplicate `claude --resume <id>` in the same cwd (which
   * would double-write the transcript jsonl — RW-046-type corruption).
   */
  private readonly resumingClaudeSessions = new Set<string>();
  /**
   * Optional listener fired whenever a session ends (stop / tmux-exit /
   * headless-finish), with its threadId (Phase 5c / #294). The DispatchQueue
   * registers it to free a concurrency slot and pump the FIFO queue. Kept generic
   * (the manager does not know "dispatch"): the queue ignores threadIds that do
   * not hold a slot, so an interactive session ending is a harmless no-op.
   */
  private dispatchEndListener?: (threadId: string) => void;
  private readonly effects: SessionEffects;
  private readonly gracefulKillTimeoutMs: number;
  private readonly resumePromptPollAttempts: number;
  private readonly resumePromptPollIntervalMs: number;
  private readonly inputReadyPollAttempts: number;
  private readonly inputReadyPollIntervalMs: number;
  private readonly watchIntervalMs: number;
  private readonly probePendingWorkFn: (
    transcriptPath: string,
  ) => PendingWorkProbe;

  constructor(options: SessionManagerOptions = {}) {
    this.effects = {
      tmux: options.effects?.tmux ?? realSessionEffects.tmux,
      iterm2: options.effects?.iterm2 ?? realSessionEffects.iterm2,
      relayServer:
        options.effects?.relayServer ?? realSessionEffects.relayServer,
      process: options.effects?.process ?? realSessionEffects.process,
      worktree: options.effects?.worktree ?? realSessionEffects.worktree,
      executor: options.effects?.executor ?? realSessionEffects.executor,
      issueReporter:
        options.effects?.issueReporter ?? realSessionEffects.issueReporter,
    };
    this.gracefulKillTimeoutMs =
      options.gracefulKillTimeoutMs ?? GRACEFUL_KILL_TIMEOUT_MS;
    this.resumePromptPollAttempts =
      options.resumePromptPollAttempts ?? RESUME_PROMPT_POLL_ATTEMPTS;
    this.resumePromptPollIntervalMs =
      options.resumePromptPollIntervalMs ?? 1000;
    this.inputReadyPollAttempts =
      options.inputReadyPollAttempts ?? INPUT_READY_POLL_ATTEMPTS;
    this.inputReadyPollIntervalMs =
      options.inputReadyPollIntervalMs ?? 1000;
    this.watchIntervalMs = options.watchIntervalMs ?? 10_000;
    this.probePendingWorkFn = options.probePendingWorkFn ?? probePendingWork;

    // Issue #227 (PR-4): ensureSocketConfigured is async now. The constructor
    // cannot await, so fire-and-forget it — it is idempotent and re-applied in
    // start()/resume() once the tmux server is definitely up (the eager call
    // here is a no-op before the first new-session). `void` discards the Promise;
    // the function catches its own errors, so there is no unhandled rejection.
    void this.effects.tmux.ensureSocketConfigured();
    this.effects.relayServer.start();
    // Issue #227 (PR-3): recoverFromDb is async now (it awaits tmux has/kill).
    // The constructor cannot await, so we keep the recovery promise for tests
    // and any caller that needs to wait for startup orphan-cleanup to finish.
    this.recovery = this.recoverFromDb();
  }

  /**
   * Startup orphan-recovery promise (Issue #227 PR-3). Resolves once
   * {@link recoverFromDb} has finished reconciling DB `running` rows against
   * live tmux sessions. Awaitable by tests that assert post-recovery state;
   * production fire-and-forgets it (recovery only kills stale tmux + marks rows
   * stopped, which races nothing the first relay depends on).
   */
  readonly recovery: Promise<void>;

  /**
   * Register the session-end listener (Phase 5c / #294). Called once at startup
   * by bot.ts to connect the DispatchQueue. Fired after a session leaves the live
   * map on any terminal path.
   */
  onSessionEnd(listener: (threadId: string) => void): void {
    this.dispatchEndListener = listener;
  }

  /** Notify the end listener, swallowing listener errors (must never break teardown). */
  private emitSessionEnd(threadId: string): void {
    try {
      this.dispatchEndListener?.(threadId);
    } catch (err) {
      console.error(
        `[SessionManager] dispatchEndListener threw for ${threadId}:`,
        err,
      );
    }
  }

  count(): number {
    return this.sessions.size;
  }

  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  get(threadId: string): SessionInfo | undefined {
    return this.sessions.get(threadId);
  }

  /**
   * Authoritative liveness for the given thread (Issue #168 / Epic #166).
   * Crosses DB `status` with reality — `process.kill(pid, 0)` for the recorded
   * pid, and tmux session existence — and returns a single `alive | dead |
   * unknown` verdict. Salvage responses and resume guards share this verdict so
   * callers cannot drift from each other.
   *
   * Behaviour matrix:
   *   - no DB row for the thread                        → `unknown`
   *   - row.status !== "running"                        → `dead`
   *   - row.status === "running" + no pid recorded     → `dead`
   *   - row.status === "running" + pid alive + tmux alive → `alive`
   *   - row.status === "running" + (pid dead OR tmux missing) → `dead`
   *     (DB says running but reality contradicts — answer is the reality)
   */
  async livenessOf(threadId: string): Promise<Liveness> {
    const row = getSessionByThreadId(threadId);
    if (!row) return "unknown";
    if (row.status !== "running") return "dead";
    if (row.pid == null) return "dead";
    const pidAlive = this.effects.process.isAlive(row.pid);
    // Issue #227 (PR-3): hasSession is async now, so livenessOf is too. All
    // callers (salvage / resume guards) already await this verdict.
    const tmuxAlive = await this.effects.tmux.hasSession(
      this.tmuxSessionName(threadId)
    );
    return pidAlive && tmuxAlive ? "alive" : "dead";
  }

  /**
   * Authoritative liveness for a claude session id (Issue #171). Resolves the
   * most-recent row for the id (a single claude session may have several rows
   * across start + prior resumes — the latest run is what "is it alive now"
   * cares about) and defers to {@link livenessOf} on that row's thread.
   *
   * The resume guard uses this instead of the DB `status` column so a stale
   * `status='running'` row can't block a legitimate resume (穴 A), while a
   * genuinely-live session still rejects. Returns `unknown` when no row exists
   * for the id (callers treat `unknown` as "not alive → resume may proceed").
   */
  async livenessOfClaudeSession(claudeSessionId: string): Promise<Liveness> {
    const row = getSessionByClaudeSessionId(claudeSessionId);
    if (!row || row.thread_id == null) return "unknown";
    return this.livenessOf(row.thread_id);
  }

  entries(): IterableIterator<[string, SessionInfo]> {
    return this.sessions.entries();
  }

  listRunning(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  listRunningByChannel(channelName: string): SessionInfo[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.channelName === channelName && s.status === "running"
    );
  }

  /**
   * Read-only health snapshot of every in-memory running session (Issue #78,
   * AC-4). Backs the relay server's `GET /health/sessions` endpoint. Keeps the
   * tmux-naming logic ({@link tmuxSessionName}) as the single source of truth so
   * the E2E harness verifies the real mapping rather than a duplicated guess.
   * Excludes secrets (token, pid, process handle) by construction.
   */
  sessionsHealth(): SessionHealthInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      threadId: s.threadId,
      tmuxSession: this.tmuxSessionName(s.threadId),
      channelName: s.channelName,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
    }));
  }

  private tmuxSessionName(threadId: string): string {
    return SessionManager.tmuxSessionNameFor(threadId);
  }

  /**
   * Public, deterministic mapping from threadId → tmux session name. Exposed so
   * callers (e.g. the lifecycle E2E, Issue #144/#273) don't re-derive the
   * `claude-<threadId12>` formula and silently break when it changes.
   */
  static tmuxSessionNameFor(threadId: string): string {
    // Use a short prefix + first 12 chars of threadId for tmux session name
    return `${TMUX_SESSION_PREFIX}${threadId.slice(0, 12)}`;
  }

  /**
   * Start a new session with tmux + iTerm2 + thread.
   *
   * Issue #154: when `branch` is given the session runs in a dedicated git
   * worktree under `<config.dir>/.claude/worktrees/<branch>` instead of the
   * channel's main worktree, isolating its working tree from other sessions on
   * the same repo. Without a branch the behaviour is unchanged (cwd = config.dir).
   */
  async start(
    config: ChannelConfig,
    threadId: string,
    branch?: string,
    model?: string
  ): Promise<SessionInfo> {
    // Single-flight guard (review #185 gemini HIGH): start() is async (awaits
    // the PID poll below), so these checks must not be bypassed by a second
    // concurrent start() interleaving at the await before `this.sessions.set`
    // runs. Count pendingStarts in both guards and register threadId
    // synchronously (before any await), releasing in finally — mirrors
    // resumeSession's single-flight lock.
    if (this.sessions.size + this.pendingStarts.size >= MAX_SESSIONS) {
      throw new Error(`最大セッション数 (${MAX_SESSIONS}) に達しています`);
    }

    if (this.sessions.has(threadId) || this.pendingStarts.has(threadId)) {
      throw new Error(`このスレッドのセッションは既に稼働中です`);
    }

    if (!existsSync(config.dir)) {
      throw new Error(
        `プロジェクトディレクトリが見つかりません: ${config.dir}`
      );
    }

    this.pendingStarts.add(threadId);
    try {
      return await this.launchStart(config, threadId, branch, model);
    } finally {
      this.pendingStarts.delete(threadId);
    }
  }

  /**
   * Internal: worktree resolution + tmux launch + state registration for a
   * start, run under the pendingStarts single-flight lock held by {@link start}.
   * Split out so the lock acquire/release stays a thin, readable wrapper. Every
   * guard (MAX_SESSIONS, thread/pending collision, projectDir existence) is
   * enforced by the caller before this runs.
   */
  private async launchStart(
    config: ChannelConfig,
    threadId: string,
    branch?: string,
    model?: string
  ): Promise<SessionInfo> {
    // Issue #154: resolve the effective cwd. With a branch, create/reuse a
    // worktree (Q1/Q2/Q4 in worktree.ts); failures propagate so the caller can
    // report them rather than starting claude in the wrong directory.
    let projectDir = config.dir;
    let worktree: SessionInfo["worktree"];
    const trimmedBranch = branch?.trim();
    if (trimmedBranch) {
      const result = await this.effects.worktree.ensure(config.dir, trimmedBranch);
      projectDir = result.path;
      worktree = {
        mainRepoDir: config.dir,
        path: result.path,
        branch: trimmedBranch,
      };
      console.log(
        `[SessionManager] ${result.reused ? "Reusing existing worktree" : "Created worktree"} for branch '${trimmedBranch}': ${result.path}`
      );
    }

    const sessionId = randomUUID();
    // Pre-generate the Claude session id and pin it via `claude --session-id`
    // so the DB row captures it deterministically at start (Issue #167).
    // The previous opportunistic capture (relay round-trip in bot.ts) left
    // ~90% of rows NULL because relays time out before reporting the id; that
    // path is now an idempotent fallback (only sets when still NULL).
    const claudeSessionId = randomUUID();
    const tmuxName = this.tmuxSessionName(threadId);

    // Kill existing tmux session if any
    await this.effects.tmux.killSession(tmuxName);

    // Build the claude command — unset ANTHROPIC_API_KEY to use Claude Max subscription
    // encodeURIComponent: Discord thread IDs are numeric today, but encode at
    // the boundary so any future schema change (or fuzzed input) cannot break
    // the relay URL parser. relay-server.ts decodes symmetrically on receipt.
    const relayUrl = `http://localhost:${this.effects.relayServer.getPort()}/relay/${encodeURIComponent(threadId)}`;

    // Relay URL is written to a runtime-dir file keyed by the project cwd so
    // that progress-relay.sh (PostToolUse hook) can locate it from $CWD without
    // dropping `.supervisor-relay-url` into every project repo (Issue #88).
    // The hook applies the same sanitisation logic to its `$CWD` payload.
    const relayUrlFile = relayUrlFilePath(projectDir);
    const relayUrlDir = dirname(relayUrlFile);

    // Best-effort cleanup of any stale relay-url file from a prior session for
    // this project. Without this, a Supervisor restart can leave a file pointing
    // at a dead relay port; PostToolUse hooks would then POST to a stale URL
    // and silently time out (curl --max-time 3 in progress-relay.sh).
    this.cleanupRelayUrlFile(projectDir);

    const claudeCmd = [
      "unset ANTHROPIC_API_KEY",
      `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
      `export SUPERVISOR_RELAY_URL="${relayUrl}"`,
      `mkdir -p "${relayUrlDir}"`,
      `printf "%s" "${relayUrl}" > "${relayUrlFile}"`,
      `cd "${projectDir}"`,
      // `--session-id <uuid>` only on fresh start; resume uses `--resume <id>`
      // (the two are mutually exclusive). claudeSessionId is a randomUUID() so
      // it is shell-safe to embed here.
      // Quote claudePath() so SUPERVISOR_CLAUDE_PATH values containing spaces
      // (e.g. a test fixture under "/Users/Test User/...") don't word-split.
      `exec "${claudePath()}" --session-id ${claudeSessionId} ${buildClaudeFlags(config, model).join(" ")}`,
    ].join(" && ");

    // Launch via tmux (provides a real TTY). Uses Supervisor's dedicated
    // -L claude-hub socket (see ./tmux.ts) so user config is not inherited.
    await this.effects.tmux.newSession(tmuxName, claudeCmd);
    // Apply server-wide options now that the server is definitely running.
    // The constructor's eager call is a no-op before the first new-session.
    await this.effects.tmux.ensureSocketConfigured();

    // Wait briefly for process to start. start() is async (Issue #99) so this
    // uses a non-blocking setTimeout instead of the previous
    // `execSync("sleep 0.5")`, which spawned a shell per iteration and blocked
    // the single-process Discord bot's event loop. Mirrors resumeSession().
    let pid: number | null = null;
    for (let i = 0; i < 5; i++) {
      pid = await this.effects.tmux.getPid(tmuxName);
      if (pid) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!pid) {
      // Claude failed to come up. Drop the relay-url file the in-tmux command
      // may have written so a PostToolUse hook never POSTs to a dead port. The
      // worktree (if any) is left in place — it is valid and gets reused on the
      // next `/session start <branch>` (Q4); only an explicit /session stop
      // removes it (Q3).
      this.cleanupRelayUrlFile(projectDir);
      throw new Error(
        "Claude Code の起動に失敗しました（tmuxセッションのPID取得失敗）"
      );
    }

    const now = new Date();
    const info: SessionInfo = {
      id: sessionId,
      channelName: config.channelName,
      threadId,
      projectDir,
      pid,
      claudeSessionId,
      process: null as unknown as any, // tmux manages the process
      startedAt: now,
      lastActivityAt: now,
      status: "running",
      branch: trimmedBranch || undefined,
      worktree,
    };

    this.sessions.set(threadId, info);
    // Hand off from pendingStarts → sessions: now that the session is real, the
    // MAX_SESSIONS / dup guards count it via `this.sessions`, so drop the
    // pending marker to avoid double-counting (start()'s finally is the
    // error-path safety net; delete is idempotent).
    this.pendingStarts.delete(threadId);

    insertSession({
      id: sessionId,
      channel_name: config.channelName,
      thread_id: threadId,
      project_dir: projectDir,
      pid,
      claude_session_id: claudeSessionId,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      status: "running",
      branch: trimmedBranch ?? null,
    });

    // Monitor tmux session for exit
    this.watchTmuxSession(threadId, tmuxName, sessionId);

    console.log(
      `[SessionManager] Started ${config.channelName} via tmux (PID: ${pid}, tmux: ${tmuxName}, thread: ${threadId})`
    );

    // Open iTerm2 tab asynchronously (non-blocking, failure is safe)
    setTimeout(() => {
      this.effects.iterm2.openTab({
        tmuxSessionName: tmuxName,
        channelName: config.channelName,
        projectDir,
      });
    }, 0);

    return info;
  }

  /**
   * Start and run a dispatch job headlessly (Epic #285 Phase 2 / #287): spawn
   * `claude -p "<initialCommand>"` in the branch worktree and resolve with the
   * captured stdout/stderr/exit once the child exits. Unlike {@link start}, there
   * is NO tmux session, NO Ink TUI, and NO waitForInputReady/sendMessage — the
   * whole TUI-timing failure class (RW-025 / RW-047) is structurally absent.
   *
   * The session is registered in the live map the instant the child spawns (via
   * the adapter's onSpawn callback) so slot accounting (MAX_SESSIONS) and the
   * status endpoints see it during the run, and closed on exit ({@link
   * finishHeadless}). The reapers deliberately skip `executor:"headless"`
   * sessions (orphan-dispatch-reaper.ts / goal-watcher.ts) because a headless
   * session self-terminates — its child process, bounded by the run timeout, is
   * the authoritative liveness signal, not tmux idle time.
   *
   * Guards mirror {@link start} (MAX_SESSIONS, thread/pending collision,
   * projectDir existence). A spawn failure propagates (no session is registered,
   * onSpawn never fired) so the caller can surface it (no silent fallback).
   */
  async runHeadless(
    config: ChannelConfig,
    threadId: string,
    initialCommand: string,
    branch?: string,
    issueNumber?: number,
  ): Promise<HeadlessSessionResult> {
    // Same single-flight guards as start(): runHeadless is another async entry
    // that registers a session, so it must respect the identical MAX_SESSIONS /
    // dup / pending checks or a race could bypass them (review #185 class).
    if (this.sessions.size + this.pendingStarts.size >= MAX_SESSIONS) {
      throw new Error(`最大セッション数 (${MAX_SESSIONS}) に達しています`);
    }
    if (this.sessions.has(threadId) || this.pendingStarts.has(threadId)) {
      throw new Error(`このスレッドのセッションは既に稼働中です`);
    }
    if (!existsSync(config.dir)) {
      throw new Error(
        `プロジェクトディレクトリが見つかりません: ${config.dir}`,
      );
    }

    this.pendingStarts.add(threadId);
    try {
      // Resolve the worktree exactly as launchStart does (Issue #154): the
      // headless child runs in the per-branch worktree, isolated from other
      // sessions on the same repo. Failures propagate before any spawn.
      let projectDir = config.dir;
      let worktree: SessionInfo["worktree"];
      const trimmedBranch = branch?.trim();
      if (trimmedBranch) {
        const result = await this.effects.worktree.ensure(
          config.dir,
          trimmedBranch,
        );
        projectDir = result.path;
        worktree = {
          mainRepoDir: config.dir,
          path: result.path,
          branch: trimmedBranch,
        };
        console.log(
          `[SessionManager] ${result.reused ? "Reusing existing worktree" : "Created worktree"} for headless branch '${trimmedBranch}': ${result.path}`,
        );
      }

      const sessionId = randomUUID();
      const claudeSessionId = randomUUID();
      const args = [
        ...buildHeadlessClaudeFlags(
          config,
          initialCommand,
          resolveDispatchModel(),
        ),
        // Issue #342 Layer 1: inject the pending-work Stop hook so the worker
        // cannot end its turn (= kill the process) while background tasks or a
        // ScheduleWakeup reservation are still in flight.
        ...buildPendingGuardFlags(),
        // Pin the session id like launchStart so the DB row captures it
        // deterministically (Issue #167). randomUUID() is shell-safe, though
        // there is no shell here.
        "--session-id",
        claudeSessionId,
      ];
      const now = new Date();

      // Issue #342 Layer 2: the child's pid doubles as its process-GROUP id
      // (the executor spawns with `detached: true`), so it is kept for the
      // post-exit orphan probe.
      let spawnedPid: number | null = null;

      const result = await this.effects.executor.runHeadless({
        claudePath: claudePath(),
        args,
        cwd: projectDir,
        env: buildHeadlessEnv(),
        timeoutMs: headlessTimeoutMs(),
        onSpawn: (pid) => {
          spawnedPid = pid;
          // Register the session synchronously the moment the child exists, so
          // MAX_SESSIONS / count() reflect the in-flight run and the reapers can
          // observe it. Hand off pendingStarts → sessions (mirrors launchStart).
          const info: SessionInfo = {
            id: sessionId,
            channelName: config.channelName,
            threadId,
            projectDir,
            pid,
            claudeSessionId,
            process: null as unknown as any, // the executor owns the child
            startedAt: now,
            lastActivityAt: now,
            status: "running",
            branch: trimmedBranch || undefined,
            worktree,
            executor: "headless",
          };
          this.sessions.set(threadId, info);
          this.pendingStarts.delete(threadId);
          insertSession({
            id: sessionId,
            channel_name: config.channelName,
            thread_id: threadId,
            project_dir: projectDir,
            pid,
            claude_session_id: claudeSessionId,
            started_at: now.toISOString(),
            last_activity_at: now.toISOString(),
            status: "running",
            branch: trimmedBranch ?? null,
          });
          console.log(
            `[SessionManager] Started ${config.channelName} headless (PID: ${pid}, thread: ${threadId}, cmd: ${initialCommand})`,
          );
        },
      });

      // Parse the JSON envelope into presentable text + token usage (#289).
      // Fail-soft: a crash / timeout that left no valid JSON yields the raw
      // output and null tokens rather than throwing.
      const parsed = parseHeadlessOutput(result.stdout);

      // Issue #342 Layer 2: verify the run actually FINISHED its work before
      // treating exit 0 as success. Both observed silent failures (#338,
      // agent-base#456) exited 0 with pending background work.
      const completion = this.probeHeadlessCompletion(
        spawnedPid,
        projectDir,
        claudeSessionId,
      );
      if (completion.status !== "clean") {
        console.warn(
          `[SessionManager] Headless run for thread ${threadId} ended ` +
            `${completion.status}: ${completion.detail}`,
        );
      }

      const outcome: HeadlessSessionResult = {
        exitCode: result.exitCode,
        stdout: parsed.text,
        stderr: result.stderr,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        tokens: parsed.tokens,
        sessionId,
        claudeSessionId,
        completion,
      };

      // Post the Dispatch 実行レポート to the target Issue BEFORE finishHeadless
      // removes the worktree — gh runs in that worktree cwd (#289). Fail-soft:
      // a report failure must never block session teardown or lose the run.
      if (issueNumber != null) {
        await this.postDispatchReport(issueNumber, projectDir, outcome);
      }

      // Child exited → close the session (frees the slot). Even if onSpawn never
      // fired (should not happen unless the adapter misbehaves), finishHeadless
      // is a no-op safe cleanup.
      await this.finishHeadless(threadId, sessionId, result, worktree, completion);

      return outcome;
    } finally {
      // Error-path safety net: if the spawn threw before onSpawn, drop the
      // pending marker so the slot is not leaked (delete is idempotent).
      this.pendingStarts.delete(threadId);
    }
  }

  /**
   * Close a finished headless session (Epic #285 Phase 2 / #288). Symmetric with
   * the tmux exit path ({@link watchTmuxSession}'s tmux_exited branch): drop the
   * live map entry, record the terminal reason, and best-effort remove the
   * worktree — a headless dispatch has pushed its work to the branch (its result
   * is a PR), so the completed run's worktree is reclaimed here, matching how a
   * tmux dispatch's worktree is removed when GoalWatcher/OrphanReaper stop()s it.
   * The DB reason distinguishes a timeout so operators can audit wedged runs; the
   * success/failure detail itself is surfaced to the thread by the caller (AC-5).
   */
  /**
   * Post-exit completion probe (Issue #342 Layer 2). Two deterministic signals,
   * neither of which depends on the model's prose:
   *
   *   1. Process-group survival: the executor spawns the child `detached`, so
   *      its pid is the group id. `isAlive(-pid)` (POSIX group-target kill 0)
   *      after exit means orphaned tool subprocesses are still running — work
   *      was abandoned mid-flight. Version-independent.
   *   2. Transcript parse (`pending-work.ts`): unfinished background tasks /
   *      an unfired ScheduleWakeup reservation.
   *
   * Fail-LOUD: an unreadable transcript yields `unknown`, never `clean` — the
   * whole point is that "could not verify" must not masquerade as success.
   */
  private probeHeadlessCompletion(
    pid: number | null,
    cwd: string,
    claudeSessionId: string,
  ): HeadlessCompletion {
    // The probe is observability, not control flow: a throw here would reject
    // runHeadless AFTER the child exited, skipping finishHeadless and leaking
    // the session slot (PR #368 review). Any internal failure degrades to
    // `unknown` — loud downstream, but the teardown always runs.
    try {
      const groupAlive = pid !== null && this.effects.process.isAlive(-pid);

      const transcriptPath = deriveTranscriptPath(cwd, claudeSessionId);
      const probe = this.probePendingWorkFn(transcriptPath);

      const details: string[] = [];
      if (groupAlive) {
        details.push(`プロセスグループ ${pid} に生存プロセスあり`);
      }
      if (!probe.ok) {
        details.push(`transcript 検証不能 (${probe.error})`);
        return {
          status: groupAlive ? "pending" : "unknown",
          detail: details.join(" / "),
        };
      }
      const summary = describePendingWork(probe.value);
      if (summary) details.push(summary);
      if (groupAlive || summary) {
        return { status: "pending", detail: details.join(" / ") };
      }
      return { status: "clean", detail: "" };
    } catch (err) {
      return {
        status: "unknown",
        detail: `completion probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async finishHeadless(
    threadId: string,
    sessionId: string,
    result: HeadlessRunResult,
    worktree: SessionInfo["worktree"],
    completion: HeadlessCompletion,
  ): Promise<void> {
    this.sessions.delete(threadId);
    this.emitSessionEnd(threadId); // Phase 5c: free a dispatch queue slot (#294)
    this.clearWatcher(threadId); // defensive: headless never sets one
    const reason: StopReason = result.timedOut
      ? "headless_timeout"
      : "headless_exited";
    updateSessionStatus(sessionId, "stopped", reason);
    // No relay-url file to clean: buildHeadlessEnv() does not set
    // SUPERVISOR_RELAY_URL and the headless child never writes one (stdout is
    // captured directly), so there is nothing the progress-relay hook could
    // have dropped for this cwd.
    if (worktree && completion.status !== "clean") {
      // Issue #342: a pending/unknown run is not a success — keep the worktree
      // (and its uncommitted work) recoverable instead of `--force`-removing it
      // under possibly-live orphan processes (RW-046 class). `worktree.ensure`
      // reuses an existing worktree, so a re-dispatch of the same branch picks
      // the state right back up.
      console.warn(
        `[SessionManager] Headless run ended ${completion.status} — retaining worktree ${worktree.path} for recovery (${completion.detail})`,
      );
    } else if (worktree && !this.isWorktreePathInUse(worktree.path)) {
      await this.removeWorktreeBestEffort(worktree);
    } else if (worktree) {
      console.log(
        `[SessionManager] Headless worktree ${worktree.path} still in use by another session; not removing`,
      );
    }
    console.log(
      `[SessionManager] Headless session for thread ${threadId} closed (reason: ${reason}, exit: ${result.exitCode}, completion: ${completion.status})`,
    );
  }

  /**
   * Append the Dispatch 実行レポート to the target Issue (Epic #75 Phase 4 /
   * #289). Runs `gh issue comment` in the branch worktree `cwd` (via the injected
   * {@link IssueReporterAdapter}) so the Issue's repo resolves from that dir's git
   * remote. FAIL-SOFT: any failure is logged and swallowed — a report is
   * observability, so it must never abort the run or block session teardown
   * (agent-output-quality: the failure is surfaced in the log, not silently
   * dropped).
   */
  private async postDispatchReport(
    issueNumber: number,
    cwd: string,
    outcome: HeadlessSessionResult,
  ): Promise<void> {
    const body = formatDispatchReport({
      tokens: outcome.tokens,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      completion: outcome.completion.status,
      completionDetail: outcome.completion.detail || undefined,
    });
    try {
      await this.effects.issueReporter.postComment({ cwd, issueNumber, body });
      console.log(
        `[SessionManager] Posted dispatch report to issue #${issueNumber} (tokens: ${outcome.tokens ?? "n/a"}, duration_ms: ${outcome.durationMs}, exit: ${outcome.exitCode})`,
      );
    } catch (err) {
      console.warn(
        `[SessionManager] Failed to post dispatch report to issue #${issueNumber} (fail-soft, run unaffected):`,
        err,
      );
    }
  }

  /**
   * Look up a stopped (or any) session by its Claude session id so the caller
   * can validate it before resuming. Returns the most recent matching row, or
   * undefined when the id is unknown (Issue #161).
   */
  findResumableSession(claudeSessionId: string): SessionRow | undefined {
    return getSessionByClaudeSessionId(claudeSessionId);
  }

  /**
   * Resume a previously-stopped Claude session in a fresh thread with full
   * relay wiring (Issue #161). Unlike {@link start}, this passes
   * `claude --resume <id>` so the conversation history is preserved.
   *
   * `projectDir` MUST be the directory the original session ran in (recorded in
   * sessions.db): `claude --resume` keys the transcript by cwd, so resuming
   * from any other directory — including a `-w` worktree — fails to find the
   * jsonl. When `projectDir` is missing but a `branch` is recorded, the
   * worktree is re-created at the same path before launching (Issue #217);
   * only when recovery is impossible (no branch recorded, or the branch was
   * deleted) does this throw, so the caller reports it instead of silently
   * starting a fresh conversation.
   */
  async resumeSession(
    config: ChannelConfig,
    threadId: string,
    claudeSessionId: string,
    projectDir: string,
    branch?: string | null
  ): Promise<SessionInfo> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`最大セッション数 (${MAX_SESSIONS}) に達しています`);
    }
    if (this.sessions.has(threadId)) {
      throw new Error(`このスレッドのセッションは既に稼働中です`);
    }
    if (!CLAUDE_SESSION_ID_RE.test(claudeSessionId)) {
      throw new Error(
        `claude session id の形式が不正です: ${claudeSessionId}`
      );
    }
    // Single-flight guard (Issue #171, 穴 C): reject a second concurrent resume
    // of the SAME claude session id. Mutated synchronously and held across the
    // awaits inside launchResume, so on the single-threaded event loop the
    // second caller observes the lock and fails before launching a duplicate
    // `claude --resume <id>` in the same cwd (RW-046-type transcript corruption).
    if (this.resumingClaudeSessions.has(claudeSessionId)) {
      throw new Error(
        "この session は現在 resume 処理中です。完了までお待ちください（多重 resume 防止）。"
      );
    }
    this.resumingClaudeSessions.add(claudeSessionId);
    try {
      // Authoritative liveness re-check UNDER the lock (Issue #171, 穴 A). The
      // handler checks too for fast UX, but re-checking here closes the TOCTOU
      // between the handler's check and our insert: a session that became alive
      // (or was already alive) is rejected; a stale `status='running'` row whose
      // process is dead is treated as dead and resume proceeds.
      if ((await this.livenessOfClaudeSession(claudeSessionId)) === "alive") {
        throw new Error(
          "この session は既に稼働中です。稼働中のスレッドで操作してください（多重 resume 防止）。"
        );
      }
      // Issue #217: a branch session's worktree is physically removed on
      // /session stop (Q3, RW-046), but the branch and the conversation
      // transcript (keyed by cwd) survive. Re-create the worktree at the
      // recorded projectDir so `claude --resume` finds the transcript. Run this
      // UNDER the single-flight lock so two concurrent resumes of the same id
      // cannot both `git worktree add` the same path (review #217 must-1). A
      // deleted branch is intentionally NOT rebuilt from the default branch
      // (that would resume into unrelated content) — surface a clear error.
      let recoveredWorktree: SessionInfo["worktree"];
      if (!existsSync(projectDir)) {
        const trimmedBranch = branch?.trim();
        const recovered = trimmedBranch
          ? await this.recoverWorktreeForResume(config.dir, projectDir, trimmedBranch)
          : false;
        if (recovered && existsSync(projectDir) && trimmedBranch) {
          // We rebuilt the worktree, so THIS resumed session now owns its
          // cleanup — a later /session stop removes it (last-user-only via
          // isWorktreePathInUse). Without this the recreated dir would leak,
          // since resume otherwise carries no worktree (review #217 should-3).
          recoveredWorktree = {
            mainRepoDir: config.dir,
            path: projectDir,
            branch: trimmedBranch,
          };
        } else if (recovered && !existsSync(projectDir)) {
          // recreateForBranch reported success but the recorded projectDir is
          // still missing → the rebuilt path differs from projectDir (likely a
          // config.dir drift between start and resume). Surface it so the
          // mismatch is diagnosable instead of masquerading as "branch gone"
          // (review #217 must-2).
          console.warn(
            `[SessionManager] Worktree recovery reported success but ${projectDir} is still missing; ` +
              `the recorded projectDir likely differs from <config.dir>/.claude/worktrees/<branch>`
          );
        }
        if (!existsSync(projectDir)) {
          if (trimmedBranch) {
            throw new Error(
              `セッションの作業ディレクトリ（worktree）を再生成できませんでした: ${projectDir}\n` +
                `branch '${trimmedBranch}' が削除されている可能性があります。branch を復元してから再度 resume してください。`
            );
          }
          throw new Error(
            `プロジェクトディレクトリが見つかりません: ${projectDir}（worktree が削除された可能性があります）`
          );
        }
      }
      return await this.launchResume(
        config,
        threadId,
        claudeSessionId,
        projectDir,
        branch,
        recoveredWorktree
      );
    } finally {
      this.resumingClaudeSessions.delete(claudeSessionId);
    }
  }

  /**
   * Internal: the actual tmux launch + state registration for a resume, run
   * under the single-flight lock held by {@link resumeSession}. Split out so the
   * lock acquire/release and the authoritative liveness re-check stay a thin,
   * readable wrapper. Every guard (MAX_SESSIONS, thread collision, UUID shape,
   * projectDir existence, liveness) is enforced by the caller before this runs.
   */
  private async launchResume(
    config: ChannelConfig,
    threadId: string,
    claudeSessionId: string,
    projectDir: string,
    branch?: string | null,
    recoveredWorktree?: SessionInfo["worktree"]
  ): Promise<SessionInfo> {
    const sessionId = randomUUID();
    const tmuxName = this.tmuxSessionName(threadId);
    await this.effects.tmux.killSession(tmuxName);

    const relayUrl = `http://localhost:${this.effects.relayServer.getPort()}/relay/${encodeURIComponent(threadId)}`;
    const relayUrlFile = relayUrlFilePath(projectDir);
    const relayUrlDir = dirname(relayUrlFile);
    this.cleanupRelayUrlFile(projectDir);

    // `--resume <id>` continues the prior conversation in-place (no
    // --fork-session, so the same claude session id keeps accumulating).
    // claudeSessionId is validated as a UUID above, so embedding it in the
    // bash string is shell-safe. The command is passed to tmux via execFileSync
    // (argv) in the adapter, so it is not subject to outer-shell parsing.
    const resumeFlags = [
      "--resume",
      claudeSessionId,
      ...buildClaudeFlags(config),
    ];
    const claudeCmd = [
      "unset ANTHROPIC_API_KEY",
      `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
      `export SUPERVISOR_RELAY_URL="${relayUrl}"`,
      `mkdir -p "${relayUrlDir}"`,
      `printf "%s" "${relayUrl}" > "${relayUrlFile}"`,
      `cd "${projectDir}"`,
      // Quote claudePath() (space-safe); resume path mirrors start's exec above.
      `exec "${claudePath()}" ${resumeFlags.join(" ")}`,
    ].join(" && ");

    await this.effects.tmux.newSession(tmuxName, claudeCmd);
    await this.effects.tmux.ensureSocketConfigured();

    let pid: number | null = null;
    for (let i = 0; i < 5; i++) {
      pid = await this.effects.tmux.getPid(tmuxName);
      if (pid) break;
      // Async wait — resumeSession is async, so unlike start()'s synchronous
      // execSync("sleep") this does not block the single-process Discord bot's
      // event loop while the tmux pane spins up (PR #162 review: gemini medium).
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!pid) {
      this.cleanupRelayUrlFile(projectDir);
      throw new Error(
        "Claude Code の起動に失敗しました（tmuxセッションのPID取得失敗）"
      );
    }

    const now = new Date();
    const info: SessionInfo = {
      id: sessionId,
      channelName: config.channelName,
      threadId,
      projectDir,
      pid,
      process: null as unknown as any, // tmux manages the process
      claudeSessionId,
      startedAt: now,
      lastActivityAt: now,
      status: "running",
      // Normally no worktree on resume (runs in the recorded cwd). The exception
      // is Issue #217: when resume re-created a removed branch worktree, carry it
      // so a later /session stop cleans up what this resume rebuilt. Always keep
      // the branch for same-branch counting / thread title (Issue #175).
      branch: branch || undefined,
      worktree: recoveredWorktree,
    };

    // Post-launch init (prompt confirm + state registration) can throw. tmux is
    // already running by now, so on failure we must kill it and drop the
    // relay-url file — otherwise Discord reports failure while a Claude/tmux
    // process is left orphaned (PR #162 review: CodeRabbit Major).
    try {
      // Auto-confirm the interactive "Resume from summary" prompt if it appears.
      // Awaited (not fire-and-forget) so the session is registered only AFTER the
      // TUI reaches its normal input prompt — see the ordering note below.
      await this.confirmResumePromptIfPresent(tmuxName);

      this.sessions.set(threadId, info);

      insertSession({
        id: sessionId,
        channel_name: config.channelName,
        thread_id: threadId,
        project_dir: projectDir,
        pid,
        claude_session_id: claudeSessionId,
        started_at: now.toISOString(),
        last_activity_at: now.toISOString(),
        status: "running",
        // Carry the original session's branch (Issue #175) so the resumed
        // thread title and any later /session list stay branch-consistent.
        branch: branch ?? null,
      });
    } catch (err) {
      this.sessions.delete(threadId);
      await this.effects.tmux.killSession(tmuxName);
      this.cleanupRelayUrlFile(projectDir);
      throw err;
    }

    this.watchTmuxSession(threadId, tmuxName, sessionId);

    console.log(
      `[SessionManager] Resumed ${config.channelName} (claude session ${claudeSessionId}) via tmux (PID: ${pid}, tmux: ${tmuxName}, thread: ${threadId})`
    );

    setTimeout(() => {
      this.effects.iterm2.openTab({
        tmuxSessionName: tmuxName,
        channelName: config.channelName,
        projectDir,
      });
    }, 0);

    return info;
  }

  /**
   * Poll the pane for Claude Code's "Resume from summary" prompt and select
   * option 2 "Resume full session as-is" (Down then Enter). The picker
   * highlights option 1 "Resume from summary (recommended)" by default, but we
   * always want the full conversation, not a summary (Issue #163), so we move
   * the selection down one before confirming. Marker-based rather than a fixed
   * sleep (RW-025/027): if the marker never appears the session resumed without
   * a prompt (a non-compacted session resumes full directly) and we proceed
   * without sending stray keys.
   *
   * The wait between polls uses an awaited `setTimeout`, not a synchronous
   * `execSync("sleep")`, so the single-process Discord bot's event loop stays
   * free while polling (PR #162 review: a synchronous sleep would block all
   * other channels' relays for up to ~6s). The caller awaits this method, so
   * the non-blocking change does NOT weaken the ordering guarantee — the
   * session is still registered only after the prompt is confirmed, so a
   * relayed message can never race the prompt picker (#86 / RW-019 class bug).
   */
  private async confirmResumePromptIfPresent(tmuxName: string): Promise<void> {
    for (let i = 0; i < this.resumePromptPollAttempts; i++) {
      const pane = await this.effects.tmux.capturePane(tmuxName);
      if (RESUME_PROMPT_RE.test(pane)) {
        // Down moves from option 1 (summary, highlighted) to option 2 (full
        // session as-is); C-m confirms. See Issue #163.
        await this.effects.tmux.sendKeys(tmuxName, ["Down", "C-m"]);
        return;
      }
      // Reached the normal input prompt with no picker — stop polling instead
      // of waiting out the (multi-minute) window for a picker that won't appear
      // (Issue #163). Checked after the picker so the picker always wins.
      if (RESUME_READY_RE.test(pane)) {
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.resumePromptPollIntervalMs)
      );
    }
  }

  /**
   * Poll a freshly started session's pane until its Ink TUI is ready to accept
   * input ({@link INPUT_READY_RE}). The dispatch transport (dispatch.ts) awaits
   * this before injecting the `/impl <N>` slash command: {@link start} only
   * waits for the PID, so the TUI is still booting (CLAUDE.md / skills / MCP)
   * when start() returns. Injecting a slash command into a not-yet-ready TUI
   * lets the Ink slash-picker eat the leading `/` and strands the text
   * un-submitted (RW-025 / RW-047 timing class — the same bug a fixed sleep
   * would only paper over).
   *
   * Returns true when the marker appears, false on timeout or a dead pane.
   * Marker-based, not a fixed sleep; the inter-poll wait is a non-blocking
   * awaited setTimeout so the single-process bot's event loop stays free for
   * other channels' relays while this session boots.
   */
  async waitForInputReady(threadId: string): Promise<boolean> {
    const tmuxName = this.tmuxSessionName(threadId);
    for (let i = 0; i < this.inputReadyPollAttempts; i++) {
      if (!(await this.effects.tmux.hasSession(tmuxName))) return false;
      const pane = await this.effects.tmux.capturePane(tmuxName);
      if (INPUT_READY_RE.test(pane)) return true;
      await new Promise((resolve) =>
        setTimeout(resolve, this.inputReadyPollIntervalMs)
      );
    }
    return false;
  }

  /**
   * Send a message to the Claude Code session via tmux and get the response.
   *
   * Issue #57: `onDialogStuck` is forwarded to the relay's dialog watchdog;
   * if a dialog (Plan / AskUserQuestion / MCP elicitation / Bash y/n) slips
   * past `--dangerously-skip-permissions` and resists auto-accept, the
   * callback runs so the Discord layer can post a heartbeat to the thread.
   */
  async sendMessage(
    threadId: string,
    message: string,
    attachments?: AttachmentInfo[],
    options?: Pick<RelayMessageOptions, "onDialogStuck">
  ): Promise<RelayResult> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`スレッド ${threadId} にセッションが見つかりません`);
    }

    // Update activity timestamp
    session.lastActivityAt = new Date();
    updateSessionActivity(session.id);

    const tmuxName = this.tmuxSessionName(threadId);

    // Check tmux session is alive
    if (!(await this.effects.tmux.hasSession(tmuxName))) {
      return {
        text: "",
        chunks: ["⚠️ Claude Code セッションが終了しています。`/session start` で再起動してください。"],
        error: "tmux session dead",
      };
    }

    return relayMessage(tmuxName, threadId, message, {
      attachments,
      // Issue #152: persist attachments as project assets so they outlive the
      // 5-min tmp cleanup and stay readable for the whole task.
      persistDir: session.projectDir,
      onDialogStuck: options?.onDialogStuck,
    });
  }

  /**
   * Issue #204: feed the latest context token count (from the relay's Stop-hook
   * POST) for a thread and return a degraded warning the caller should post to
   * the Discord thread — but only when the session first crosses *up* into a
   * higher context-rot band. Returns null when the count is below the yellow
   * threshold, was already warned at that band (de-dup, no per-turn spam), or
   * the session/token count is unknown. Pure bookkeeping: the caller (bot.ts)
   * owns the actual Discord/Pushover delivery so this stays unit-testable and
   * cannot break the relay loop.
   */
  contextBudgetWarning(
    threadId: string,
    tokens: number | undefined
  ): ContextBudgetWarning | null {
    if (tokens == null) return null;
    const session = this.sessions.get(threadId);
    if (!session) return null;
    if (!session.contextBudgetTracker) {
      session.contextBudgetTracker = createContextBudgetTracker();
    }
    return session.contextBudgetTracker.check(tokens);
  }

  /**
   * Issue #206: self-healing on top of the #204 notify-only budget warning.
   *
   * Reuses {@link contextBudgetWarning} (so the de-dup tracker advances exactly
   * once) and, when a session crosses up into red, automatically relays a
   * `/session compact` — the safe fire-and-forget primitive ({@link
   * compactSession}). A per-session cap (RW-043) bounds how many auto-compacts
   * fire so a rebounding context cannot loop forever; at the cap we stop and
   * prompt manual intervention. critical stays notify-only here: the right
   * remedy is a resume-backed restart, whose EXECUTION is deferred to a focused
   * follow-up (RW-047 resume-timing risk + new-thread orchestration).
   *
   * critical now resolves to a resume-backed restart (Issue #244): the planner
   * returns `restart` and this hands the caller (bot.ts) the session identity
   * (claude session id / channel / cwd / branch) it needs to drive the
   * stop→new-thread→resume orchestration, captured BEFORE any stop. When the
   * claude session id is not yet known the restart degrades to the manual
   * `/session resume` guidance (action `notify`) rather than acting blindly.
   *
   * Best-effort and self-contained: an auto-compact failure is folded into the
   * returned message (never thrown) so the relay loop is unaffected. Returns the
   * outcome the caller posts to the thread, or null when no band was crossed.
   */
  async contextBudgetSelfHeal(
    threadId: string,
    tokens: number | undefined
  ): Promise<SelfHealOutcome | null> {
    const warning = this.contextBudgetWarning(threadId, tokens);
    if (!warning) return null;

    const session = this.sessions.get(threadId);
    // contextBudgetWarning only returns non-null when the session exists, but
    // guard anyway so a race (stop between the two lookups) fails safe.
    if (!session) return null;

    // Resolve the per-CONVERSATION planner, keyed by claude session id so the
    // auto-action cap survives a self-heal restart (see {@link selfHealers}).
    // Fall back to threadId only when the id was not captured (a session that
    // never responded) — such a session can't be resumed anyway, so the
    // restart branch below degrades to manual.
    const healerKey = session.claudeSessionId ?? threadId;
    let healer = this.selfHealers.get(healerKey);
    if (!healer) {
      healer = createSelfHealer();
      this.selfHealers.set(healerKey, healer);
    }

    const decision = healer.decide(warning.level);
    const page = warning.level === "red" || warning.level === "critical";

    // Structured, greppable log for every band crossing (observability, AC item
    // 4). Secrets-free: only threadId + numeric/level fields.
    console.warn(
      `[self-heal] thread=${threadId} level=${warning.level} tokens=${warning.tokens} action=${decision.action} count=${decision.actionCount}/${decision.cap}`
    );

    if (decision.action === "compact") {
      try {
        await this.compactSession(threadId, AUTO_COMPACT_INTENT);
        return {
          level: warning.level,
          action: "compact",
          tokens: warning.tokens,
          page,
          message:
            `🩹 コンテキストが ${Math.floor(warning.tokens / 1000)}k に到達したため自動で ` +
            `\`/compact\` を実行しました（${decision.actionCount}/${decision.cap} 回目, #206）。` +
            `圧縮後も高止まりする場合は手動で \`/session compact\` するか新セッションへ切替えてください。`,
        };
      } catch (err) {
        // Auto-compact failed (e.g. tmux pane gone) — fall back to the manual
        // recommendation so the user still acts.
        return {
          level: warning.level,
          action: "compact",
          tokens: warning.tokens,
          page,
          message:
            `⚠️ 自動 \`/compact\` を試みましたが失敗しました（${err instanceof Error ? err.message : String(err)}）。` +
            `手動で \`/session compact\` を実行してください (#206)。`,
        };
      }
    }

    if (decision.action === "cap-reached") {
      return {
        level: warning.level,
        action: "cap-reached",
        tokens: warning.tokens,
        page,
        message:
          `🛑 自動リカバリの上限（${decision.cap} 回）に達しました。これ以上は自動対応しません。` +
          `手動で \`/session compact\` するか新セッションへ切替えてください (#206)。`,
      };
    }

    if (decision.action === "restart") {
      // Capture the session identity NOW — bot.ts stops this session before
      // resuming, after which `this.sessions.get(threadId)` is gone (#244).
      const claudeSessionId = session.claudeSessionId;
      if (claudeSessionId) {
        return {
          level: warning.level,
          action: "restart",
          tokens: warning.tokens,
          page,
          message:
            `🔄 コンテキストが ${Math.floor(warning.tokens / 1000)}k（critical）に到達したため、` +
            `会話を引き継いで自動 restart します（${decision.actionCount}/${decision.cap} 回目, #244）。`,
          restart: {
            claudeSessionId,
            channelName: session.channelName,
            projectDir: session.projectDir,
            branch: session.branch ?? null,
          },
        };
      }
      // No claude session id captured yet → resume has nothing to target. Degrade
      // to the manual-restart guidance instead of acting blindly (#244, no silent
      // failure). `notify` is delivered as-is by the caller (no restart payload).
      return {
        level: warning.level,
        action: "notify",
        tokens: warning.tokens,
        page,
        message:
          `${warning.message}\n↳ 自動 restart は session id 未取得のため実行できませんでした。` +
          `\`/session list\` で session_id を確認し \`/session resume <session_id>\` で復帰してください (#244)。`,
      };
    }

    // "none" (yellow) — keep the #204 notify-only warning text. (red→compact,
    // critical→restart, and cap-reached all returned above; a degraded restart
    // returns "notify" inline above with its own guidance.)
    return {
      level: warning.level,
      action: decision.action,
      tokens: warning.tokens,
      page,
      message: warning.message,
    };
  }

  /**
   * Issue #200: relay a `/compact <intent>` into the session's TUI as a
   * fire-and-forget send. Unlike {@link sendMessage}, this does NOT wait for a
   * relay (Stop-hook) response: the `/compact` built-in compacts context and
   * does not POST to the relay server, so waiting would only burn
   * RELAY_TIMEOUT_MS (default 15 min). The caller acks immediately.
   *
   * `intent` is always non-empty by contract (the command layer substitutes a
   * default) — a bare `/compact` is never sent (RW-032: bad-compact prevention).
   * Throws if the thread has no session or the tmux pane is gone, so the caller
   * can surface a clear failure instead of silently dropping the request.
   */
  async compactSession(threadId: string, intent: string): Promise<void> {
    // RW-032 made a hard invariant, not just documentation: reject an empty
    // intent so a future caller can never relay a bare `/compact` (which
    // produces a bad compact). The command layer always substitutes a default,
    // so this only fires on a programming error.
    if (!intent.trim()) {
      throw new Error("compact intent must be non-empty (RW-032)");
    }

    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`スレッド ${threadId} にセッションが見つかりません`);
    }

    // Issue #364: reject an overlapping compact on the same thread rather than
    // interleaving two send-keys sequences into one pane. Claimed before the
    // first await after this point so two callers can't both pass the check.
    if (this.compactInFlight.has(threadId)) {
      throw new CompactInFlightError(threadId);
    }
    this.compactInFlight.add(threadId);

    try {
      const tmuxName = this.tmuxSessionName(threadId);
      if (!(await this.effects.tmux.hasSession(tmuxName))) {
        throw new Error("tmux session dead");
      }

      session.lastActivityAt = new Date();
      updateSessionActivity(session.id);

      // Fire-and-forget. On a mid-sequence sendToPane failure the pane may be left
      // in an indeterminate state (e.g. the Escape landed but the literal/Enter
      // did not); the caller surfaces the throw so the user can retry.
      await sendToPane(tmuxName, `/compact ${intent}`);
    } finally {
      this.compactInFlight.delete(threadId);
    }
  }

  /**
   * Issue #199 AC1: compact the claudeHubExit primary-channel session.
   *
   * Unlike {@link compactSession} (a SessionManager-managed thread session on
   * the `-L claude-hub` socket), claudeHubExit is a long-lived launchd process
   * on the DEFAULT tmux socket, outside SessionManager. Delegated to
   * primary-compact — the single sanctioned cross-socket reach — which checks
   * liveness and throws `"claudeHubExit session dead"` when absent so the
   * command layer can surface an ephemeral error (AC3 parity). `intent` is
   * non-empty by contract (the command layer substitutes a default; RW-032).
   */
  async compactPrimarySession(intent: string): Promise<void> {
    await compactClaudeHubExit(intent);
  }

  async stop(
    threadId: string,
    reason: StopReason = "manual"
  ): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`スレッド ${threadId} にセッションが見つかりません`);
    }

    session.status = "stopping";
    this.effects.relayServer.cancel(threadId);
    const tmuxName = this.tmuxSessionName(threadId);

    console.log(
      `[SessionManager] Stopping ${session.channelName} in thread ${threadId} (reason: ${reason})`
    );

    // Send SIGTERM to the claude process
    try {
      this.effects.process.kill(session.pid, "SIGTERM");
    } catch {
      // Process already dead
    }

    // Wait for graceful shutdown, then force kill tmux session
    await new Promise<void>((resolve) => {
      setTimeout(async () => {
        // Issue #227 (PR-3): killSession is now async; await it before resolving
        // so the graceful-kill wait still completes only after the tmux session
        // is actually gone (ordering unchanged from the sync version).
        await this.effects.tmux.killSession(tmuxName);
        resolve();
      }, this.gracefulKillTimeoutMs);
    });

    this.clearWatcher(threadId);
    this.sessions.delete(threadId);
    this.emitSessionEnd(threadId); // Phase 5c: free a dispatch queue slot (#294)
    // Issue #244: drop the per-conversation self-heal planner on a TERMINAL stop
    // so its cap does not leak. A `self_heal_restart` stop is NOT terminal — the
    // conversation is about to be `claude --resume`d into a fresh thread, so the
    // planner (and its accumulated auto-action count) must carry forward to bound
    // the restart chain (AC item 2). All other reasons end the conversation here.
    if (reason !== "self_heal_restart") {
      this.selfHealers.delete(session.claudeSessionId ?? threadId);
    }
    this.effects.iterm2.markTabStopped(session.channelName, tmuxName);
    updateSessionStatus(session.id, "stopped", reason);
    this.cleanupRelayUrlFile(session.projectDir);

    // Issue #154 (Q3): remove the per-branch worktree on stop; the branch is
    // preserved. But Q4 allows multiple sessions to share one worktree (同
    // branch 多重 session). `this.sessions` no longer contains the current
    // thread (deleted above), so if any *other* running session still points
    // at this worktree path, removing it would destroy that live session's
    // cwd. Only the last session on the worktree removes it (PR #157 review,
    // CodeRabbit Major).
    if (session.worktree && !this.isWorktreePathInUse(session.worktree.path)) {
      await this.removeWorktreeBestEffort(session.worktree);
    } else if (session.worktree) {
      console.log(
        `[SessionManager] Worktree ${session.worktree.path} still in use by another session; not removing`
      );
    }
  }

  /**
   * Issue #217: re-create a stopped branch session's worktree so it can resume.
   * `/session stop` removes the worktree (Q3) but the branch and the cwd-keyed
   * transcript survive, so rebuilding the worktree at `projectDir` restores the
   * cwd `claude --resume` needs. Only an existing branch is rebuilt (Q1/Q4); a
   * deleted branch returns false so the caller reports a clear error rather than
   * fabricating unrelated content. Failures are swallowed → false, leaving the
   * caller's existsSync re-check to decide the outcome deterministically.
   */
  private async recoverWorktreeForResume(
    mainRepoDir: string,
    projectDir: string,
    branch: string
  ): Promise<boolean> {
    try {
      const ok = await this.effects.worktree.recreateForBranch(mainRepoDir, branch);
      if (ok) {
        console.log(
          `[SessionManager] Re-created worktree for branch '${branch}' to resume: ${projectDir}`
        );
      } else {
        console.warn(
          `[SessionManager] Cannot re-create worktree for branch '${branch}' (branch missing?); resume of ${projectDir} will fail`
        );
      }
      return ok;
    } catch (err) {
      console.warn(
        `[SessionManager] Failed to re-create worktree for branch '${branch}':`,
        err
      );
      return false;
    }
  }

  /** True if a still-running session (other than the one just removed) uses this worktree path. */
  private isWorktreePathInUse(worktreePath: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.worktree?.path === worktreePath) return true;
    }
    return false;
  }

  /**
   * Remove a session's worktree, swallowing failures (Issue #154, Q3). A stuck
   * worktree must never block session teardown, so a removal error is logged
   * and ignored. No-op when the session had no worktree.
   */
  private async removeWorktreeBestEffort(
    worktree: SessionInfo["worktree"]
  ): Promise<void> {
    if (!worktree) return;
    try {
      await this.effects.worktree.remove(worktree.mainRepoDir, worktree.path);
      console.log(
        `[SessionManager] Removed worktree ${worktree.path} (branch '${worktree.branch}' preserved)`
      );
    } catch (err) {
      console.warn(
        `[SessionManager] Failed to remove worktree ${worktree.path}:`,
        err
      );
    }
  }

  touchActivity(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.lastActivityAt = new Date();
      updateSessionActivity(session.id);
    }
  }

  async shutdownAll(): Promise<void> {
    console.log("[SessionManager] Shutting down all sessions...");
    const promises = Array.from(this.sessions.keys()).map((threadId) =>
      this.stop(threadId, "manual").catch((err) =>
        console.error(`[SessionManager] Error stopping ${threadId}:`, err)
      )
    );
    await Promise.allSettled(promises);
    // Clear any remaining watchers (defensive — stop() already clears them).
    for (const handle of this.watchers.values()) {
      clearInterval(handle);
    }
    this.watchers.clear();
    // Defensive — stop("manual") already drops each, but clear any orphan left
    // by a failed-then-unresumed self_heal_restart (Issue #244).
    this.selfHealers.clear();
    this.effects.relayServer.stop();
    console.log("[SessionManager] All sessions stopped.");
  }

  private clearWatcher(threadId: string): void {
    const handle = this.watchers.get(threadId);
    if (handle) {
      clearInterval(handle);
      this.watchers.delete(threadId);
    }
  }

  private watchTmuxSession(
    threadId: string,
    tmuxName: string,
    sessionId: string
  ): void {
    // Issue #227 (PR-3): hasSession is now async (it awaits a tmux call that can
    // take up to TMUX_CALL_TIMEOUT_MS under load). A 10s poll could therefore
    // fire the next tick before the previous tick's check resolves, letting two
    // ticks both observe "exited" and run teardown twice. `isChecking` is a
    // re-entry guard: a tick that overlaps a still-running check simply skips.
    let isChecking = false;
    const interval = setInterval(async () => {
      if (isChecking) return;
      isChecking = true;
      try {
        if (!(await this.effects.tmux.hasSession(tmuxName))) {
          const session = this.sessions.get(threadId);
          console.log(
            `[SessionManager] tmux session ${tmuxName} exited`
          );
          this.sessions.delete(threadId);
          this.emitSessionEnd(threadId); // Phase 5c: free a dispatch queue slot (#294)
          if (session) {
            this.effects.iterm2.markTabStopped(session.channelName, tmuxName);
            this.cleanupRelayUrlFile(session.projectDir);
            // Issue #244: an unexpected exit ends this conversation generation —
            // drop its self-heal planner so the cap map does not leak. A later
            // manual /session resume legitimately starts a fresh planner.
            this.selfHealers.delete(session.claudeSessionId ?? threadId);
            // Issue #154: the worktree is intentionally NOT removed here. An
            // unexpected claude exit is not an explicit teardown — removing the
            // worktree (git worktree remove --force) would discard any
            // uncommitted work the user did not choose to drop. Only the explicit
            // /session stop removes it (Q3); until then it is reused on restart
            // of the same branch (Q4).
          }
          updateSessionStatus(sessionId, "stopped", "tmux_exited");
          this.clearWatcher(threadId);
        }
      } finally {
        isChecking = false;
      }
    }, this.watchIntervalMs); // Check every 10 seconds (overridable in tests)
    this.watchers.set(threadId, interval);
  }

  private async recoverFromDb(): Promise<void> {
    const rows = getRunningSessions();
    for (const row of rows) {
      if (row.thread_id) {
        const tmuxName = this.tmuxSessionName(row.thread_id);
        if (await this.effects.tmux.hasSession(tmuxName)) {
          console.log(
            `[SessionManager] Found running tmux session ${tmuxName}, killing (supervisor restart)`
          );
          await this.effects.tmux.killSession(tmuxName);
        }
      }
      this.cleanupRelayUrlFile(row.project_dir);
      // Issue #154: worktrees are intentionally left in place on restart. They
      // are reused on the next `/session start <branch>` (Q4) and force-removing
      // them here would discard uncommitted work without an explicit teardown.
      // Only /session stop removes a worktree (Q3).
      updateSessionStatus(row.id, "stopped", "supervisor_restart");
    }
  }

  /**
   * Best-effort removal of the relay-url file for a project. Idempotent: ENOENT
   * is treated as success (already cleaned). Called from start (before write),
   * stop (after sessions.delete), watchTmuxSession (on tmux_exited), and
   * recoverFromDb (Supervisor restart) so a dead URL never lingers and gets
   * POSTed to by progress-relay.sh.
   */
  private cleanupRelayUrlFile(projectDir: string): void {
    const relayUrlFile = relayUrlFilePath(projectDir);
    try {
      unlinkSync(relayUrlFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[SessionManager] Failed to unlink stale relay-url ${relayUrlFile}:`,
          err
        );
      }
    }
  }
}
