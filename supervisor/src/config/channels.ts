import { resolve } from "path";
import { homedir } from "os";

export interface ChannelConfig {
  channelName: string;
  dir: string;
  displayName: string;
}

const home = homedir();

export const CHANNEL_MAP = new Map<string, ChannelConfig>([
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
