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
export const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
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
