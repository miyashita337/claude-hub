import { resolve } from "path";
import { homedir } from "os";

export interface ChannelConfig {
  channelName: string;
  dir: string;
  displayName: string;
  /**
   * MCP loading profile for the supervisor session. Issue #104 / Epic #101.
   *
   * - `"none"` (default): disable all user-scope MCP servers via
   *   `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`. Skips ~10-15s of
   *   HTTP/stdio init for MCPs the relay never uses (Notion, Gmail, GDrive,
   *   GCal, Slack, Discord plugin). Output→Discord direction goes through the
   *   stdout relay, not the Discord MCP plugin.
   * - `"default"`: no `--strict-mcp-config` flag, fall back to whatever is
   *   configured in `~/.claude.json`. Use only when a channel genuinely needs
   *   one of those MCPs from inside Claude.
   *
   * If you need a curated subset, prefer adding a new profile here over
   * widening `"default"`.
   */
  mcpProfile?: "none" | "default";
  /**
   * Enable Claude in Chrome integration. Default `false` (= `--no-chrome`).
   * The Chrome extension paired connection adds ~5-10s to cold start; only
   * enable for channels that drive a browser via `mcp__claude-in-chrome__*`.
   */
  chromeEnabled?: boolean;
}

const home = homedir();

export const CHANNEL_MAP = new Map<string, ChannelConfig>([
  [
    // #corp: AI 持株会社の本社（CEO ハブ）。ここで `/session start <branch>` すると
    // ~/corp（corp secretary）のセッションが立ち、スレッド内の会話に応答し、
    // `npm run secretary -- dispatch` で各部署（衛星）チャンネルへ実装依頼を出せる。
    // branch を渡すと worktree（現 HEAD から分岐）で起動するため dispatch コードを含む。
    "corp",
    {
      channelName: "corp",
      dir: resolve(home, "corp"),
      displayName: "Corp CEO",
    },
  ],
  [
    "team-salary",
    {
      channelName: "team-salary",
      dir: resolve(home, "team_salary"),
      displayName: "Team Salary",
    },
  ],
  [
    "convert-service",
    {
      channelName: "convert-service",
      dir: resolve(home, "convert-service"),
      displayName: "Convert Service",
    },
  ],
  [
    "segment-anything",
    {
      channelName: "segment-anything",
      dir: resolve(home, "segment-anything"),
      displayName: "Segment Anything",
    },
  ],
  [
    "claude-context-manager",
    {
      channelName: "claude-context-manager",
      dir: resolve(home, "claude-context-manager"),
      displayName: "Claude Context Manager",
    },
  ],
  [
    "dev-tool",
    {
      channelName: "dev-tool",
      dir: resolve(home, "dev_tool"),
      displayName: "Dev Tool",
    },
  ],
  [
    "obsidian-img-annotator",
    {
      channelName: "obsidian-img-annotator",
      dir: resolve(home, "obsidian_img_annotator"),
      displayName: "Obsidian Img Annotator",
    },
  ],
  [
    "oci-develop",
    {
      channelName: "oci-develop",
      dir: resolve(home, "oci_develop"),
      displayName: "OCI Develop",
    },
  ],
  [
    "agent-base",
    {
      channelName: "agent-base",
      dir: resolve(home, "agent-base"),
      displayName: "Agent Base",
    },
  ],
  [
    "openclaw-rpi5-ops",
    {
      channelName: "openclaw-rpi5-ops",
      dir: resolve(home, "openclaw-rpi5-ops"),
      displayName: "Openclaw Rpi5 Ops",
    },
  ],
  [
    "vive-reading",
    {
      channelName: "vive-reading",
      dir: resolve(home, "vive-reading"),
      displayName: "Vive Reading",
    },
  ],
  [
    "video-qa",
    {
      channelName: "video-qa",
      dir: resolve(home, "agent-base/video-qa"),
      displayName: "Video QA",
    },
  ],
]);

// Meta-dependency guard: claude-hub must never be managed by Channel-Supervisor itself.
// If Supervisor crashes while managing its own repo, the Discord recovery path is lost.
// claude-hub maintenance must go through the claudeHubExit bot (--channels direct mode).
// See docs/bot-operations.md for details.
if (CHANNEL_MAP.has("claude-hub")) {
  throw new Error(
    "FATAL: claude-hub must NOT be in CHANNEL_MAP. " +
      "Use the claudeHubExit bot for claude-hub maintenance instead. " +
      "See docs/bot-operations.md for the rationale (meta-dependency prevention).",
  );
}

export const MAX_SESSIONS = 10;
export const IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const IDLE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const GRACEFUL_KILL_TIMEOUT_MS = 15_000; // 15 seconds
export const RESOURCE_CHECK_INTERVAL_MS = 30_000; // 30 seconds
export const MAX_MEMORY_PER_SESSION_MB = 2048; // 2GB
// GoalWatcher (corp #52 M3, spec §7): poll dispatch sessions' Issue labels for
// `done` and auto-stop after a grace window. 2-min poll keeps gh well under any
// rate limit (only dispatch sessions are polled); the 3-min grace gives the
// chairman time to cancel by speaking in the thread before teardown.
export const GOAL_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
export const GOAL_GRACE_MS = 3 * 60 * 1000; // 3 minutes
// OrphanDispatchReaper (Issue #275, option B): a dispatch-origin session
// (`corp-dispatch-<N>`) whose spawning corp CEO session exited but which never
// reached `done` is orphaned — GoalWatcher (done-only) skips it and the 30-day
// IDLE_TIMEOUT_MS reaper is far too slow, so it squats a MAX_SESSIONS slot
// (executor saturation). This gives dispatch sessions a much shorter idle leash
// than IDLE_TIMEOUT_MS while leaving human / interactive sessions on the 30-day
// reaper. Idle-based only: an actively-working dispatch session keeps
// `lastActivityAt` fresh (bot.ts touchActivity), so it is spared (#275 AC2). The
// idle threshold is env-overridable (`DISPATCH_ORPHAN_IDLE_MS`) for ops tuning.
export const DISPATCH_ORPHAN_IDLE_MS = 48 * 60 * 60 * 1000; // 48 hours
export const DISPATCH_ORPHAN_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// DispatchHealthReaper (Issue #279): the health-aware, short-horizon front line
// for the same executor-saturation problem the OrphanDispatchReaper backstops.
// The chairman reported dispatch sessions going silent for 2-3h and could not
// tell from Discord which were stuck vs. genuinely working, so ActivityWatchdog
// (#209) only *nudged*. This escalates nudge → auto-reap for dispatch sessions
// that have been silent past DISPATCH_HEALTH_SILENCE_MS AND have no live
// CI/build/test/push child process (the mis-fire guard — a session waiting on a
// long CI run looks silent but must NOT be killed mid-work, since stop() removes
// its worktree). The 48h OrphanDispatchReaper above stays as the coarse backstop
// for anything this front line spares (probe unknown / stuck busy child). Both
// thresholds are env-overridable for ops tuning (mirrors the orphan reaper).
export const DISPATCH_HEALTH_SILENCE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const DISPATCH_HEALTH_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Phase 5b (#293 / Epic #292): the interactive idle reaper threshold is now
// env-configurable (`SESSION_IDLE_TIMEOUT_MS`) with a much shorter default —
// idle interactive sessions squat CPU/RAM and worsen the multi-session
// saturation the Epic targets. The old 30-day value (IDLE_TIMEOUT_MS above) is
// demoted to a HARD BACKSTOP: the effective timeout is
// min(SESSION_IDLE_TIMEOUT_MS, SESSION_IDLE_BACKSTOP_MS), so a misconfigured huge
// env value can never disable reaping past 30 days. Setting
// SESSION_IDLE_TIMEOUT_MS=2592000000 restores the exact old 30-day behaviour
// (AC-1). On teardown the reaper leaves a resume導線 in the thread.
export const SESSION_IDLE_DEFAULT_MS = 6 * 60 * 60 * 1000; // 6 hours
export const SESSION_IDLE_BACKSTOP_MS = IDLE_TIMEOUT_MS; // 30 days, hard cap

// Phase 5c (#294 / Epic #292): dispatch concurrency limit + FIFO queue. When the
// number of running dispatch sessions reaches this, a new /dispatch is QUEUED
// (not rejected) and started FIFO as slots free. Interactive /session start does
// NOT go through this queue (it is capped only by MAX_SESSIONS), so the human
// experience is unchanged. Kept well under MAX_SESSIONS so interactive keeps
// headroom. Env-overridable via `DISPATCH_MAX_CONCURRENT`.
export const DISPATCH_MAX_CONCURRENT = 3;

// Phase 5d (#295 / Epic #292): dynamic admission is WARN-first — it defaults to
// OBSERVE ONLY (log a WARN when load is high, but do NOT delay). Enforcement
// (actually delaying a start under high load) is opt-in via
// `DISPATCH_ADMISSION_ENFORCE=1`, to be flipped on only after a few days of
// zero-false-positive observation (thin-scaffolding dogfood). The load ceiling
// is `core_count * ADMISSION_LOAD_FACTOR`; over it, enforcement waits
// ADMISSION_DELAY_MS before admitting (never rejects — dispatch is queued/delayed,
// not dropped).
export const ADMISSION_LOAD_FACTOR = 1.0;
export const ADMISSION_DELAY_MS = 5000; // 5s
