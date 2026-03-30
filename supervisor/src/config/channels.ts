import { resolve } from "path";
import { homedir } from "os";

export interface ChannelConfig {
  channelName: string;
  dir: string;
  displayName: string;
  botTokenEnvKey: string; // .env key for this channel's DISCORD_BOT_TOKEN
}

const home = homedir();

export const CHANNEL_MAP = new Map<string, ChannelConfig>([
  [
    "team-salary",
    {
      channelName: "team-salary",
      dir: resolve(home, "team_salary"),
      displayName: "Team Salary",
      botTokenEnvKey: "TEAM_SALARY_BOT_TOKEN",
    },
  ],
  [
    "convert-service",
    {
      channelName: "convert-service",
      dir: resolve(home, "convert-service"),
      displayName: "Convert Service",
      botTokenEnvKey: "CONVERT_SERVICE_BOT_TOKEN",
    },
  ],
  [
    "segment-anything",
    {
      channelName: "segment-anything",
      dir: resolve(home, "segment-anything"),
      displayName: "Segment Anything",
      botTokenEnvKey: "SEGMENT_ANYTHING_BOT_TOKEN",
    },
  ],
  [
    "claude-context-manager",
    {
      channelName: "claude-context-manager",
      dir: resolve(home, "claude-context-manager"),
      displayName: "Claude Context Manager",
      botTokenEnvKey: "CLAUDE_CONTEXT_MANAGER_BOT_TOKEN",
    },
  ],
  [
    "dev-tool",
    {
      channelName: "dev-tool",
      dir: resolve(home, "dev_tool"),
      displayName: "Dev Tool",
      botTokenEnvKey: "DEV_TOOL_BOT_TOKEN",
    },
  ],
  [
    "obsidian-img-annotator",
    {
      channelName: "obsidian-img-annotator",
      dir: resolve(home, "obsidian_img_annotator"),
      displayName: "Obsidian Img Annotator",
      botTokenEnvKey: "OBSIDIAN_IMG_ANNOTATOR_BOT_TOKEN",
    },
  ],
  [
    "oci-develop",
    {
      channelName: "oci-develop",
      dir: resolve(home, "oci_develop"),
      displayName: "OCI Develop",
      botTokenEnvKey: "OCI_DEVELOP_BOT_TOKEN",
    },
  ],
]);

export const MAX_SESSIONS = 10;
export const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const IDLE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const GRACEFUL_KILL_TIMEOUT_MS = 15_000; // 15 seconds
export const RESOURCE_CHECK_INTERVAL_MS = 30_000; // 30 seconds
export const MAX_MEMORY_PER_SESSION_MB = 2048; // 2GB
