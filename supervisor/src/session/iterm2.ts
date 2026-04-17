import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const PROJECT_COLORS_PATH = resolve(
  homedir(),
  ".claude",
  "scripts",
  "project-colors.json"
);

interface ProjectColorsConfig {
  projects: Record<string, string>;
  default_saturation: number;
  default_brightness: number;
}

function loadProjectColors(): ProjectColorsConfig {
  try {
    const text = readFileSync(PROJECT_COLORS_PATH, "utf8");
    return JSON.parse(text);
  } catch {
    return { projects: {}, default_saturation: 0.3, default_brightness: 0.12 };
  }
}

function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hueToRgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  // Use Math.floor to match Python's int() truncation behavior
  const r = Math.floor(hueToRgb(p, q, h + 1 / 3) * 255);
  const g = Math.floor(hueToRgb(p, q, h) * 255);
  const b = Math.floor(hueToRgb(p, q, h - 1 / 3) * 255);
  return [r, g, b];
}

export function resolveColor(projectName: string): string {
  const config = loadProjectColors();
  const projects = config.projects ?? {};

  let bestMatch = "";
  let bestColor = "";
  for (const [key, color] of Object.entries(projects)) {
    if (projectName.startsWith(key) && key.length > bestMatch.length) {
      bestMatch = key;
      bestColor = color;
    }
  }
  if (bestColor) return bestColor;

  const saturation = config.default_saturation ?? 0.3;
  const brightness = config.default_brightness ?? 0.12;
  const hash = createHash("sha256").update(projectName).digest("hex");
  const hue = (parseInt(hash.slice(0, 8), 16) % 360) / 360;
  const [r, g, b] = hlsToRgb(hue, brightness, saturation);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function isItermRunning(): boolean {
  try {
    const result = execSync("pgrep -x iTerm2", {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

export function dimColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const dr = Math.round(r * 0.5);
  const dg = Math.round(g * 0.5);
  const db = Math.round(b * 0.5);
  return `#${dr.toString(16).padStart(2, "0")}${dg.toString(16).padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}

export interface OpenTabOptions {
  tmuxSessionName: string;
  channelName: string;
  projectDir: string;
}

const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";

export function openTab(opts: OpenTabOptions): void {
  if (!isItermRunning()) {
    console.log(
      `[iTerm2] iTerm2 is not running, skipping tab creation for ${opts.channelName}`
    );
    return;
  }

  // Set tmux window name so it persists after attach
  const tabTitle = `${opts.channelName} (running)`;
  try {
    execSync(
      `${TMUX_PATH} rename-window -t "${opts.tmuxSessionName}" "${tabTitle}"`,
      { timeout: 3000 }
    );
    // Disable automatic-rename so tmux doesn't overwrite our title
    execSync(
      `${TMUX_PATH} set-option -t "${opts.tmuxSessionName}" automatic-rename off`,
      { timeout: 3000 }
    );
    // Enable set-titles so tmux pushes the window name to iTerm2's tab title
    execSync(
      `${TMUX_PATH} set-option -t "${opts.tmuxSessionName}" set-titles on`,
      { timeout: 3000 }
    );
    execSync(
      `${TMUX_PATH} set-option -t "${opts.tmuxSessionName}" set-titles-string "#{window_name}"`,
      { timeout: 3000 }
    );
    // Set pane title as well
    execSync(
      `${TMUX_PATH} select-pane -t "${opts.tmuxSessionName}" -T "${tabTitle}"`,
      { timeout: 3000 }
    );
  } catch {
    // tmux session may have already exited
  }

  const color = resolveColor(basename(opts.projectDir));
  const hex = color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) * 257;
  const g = parseInt(hex.slice(2, 4), 16) * 257;
  const b = parseInt(hex.slice(4, 6), 16) * 257;

  const script = [
    'tell application "iTerm2"',
    "  tell current window",
    "    create tab with default profile",
    "    tell current session",
    `      write text "${TMUX_PATH} attach -t ${opts.tmuxSessionName} \\\\; copy-mode"`,
    `      set name to "${tabTitle}"`,
    `      set background color to {${r}, ${g}, ${b}}`,
    "    end tell",
    "  end tell",
    "end tell",
  ].join("\n");

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 5000,
    });
    console.log(`[iTerm2] Opened tab for ${opts.channelName}`);
  } catch (err) {
    console.error(
      `[iTerm2] Failed to open tab for ${opts.channelName}:`,
      err
    );
  }
}

export function markTabStopped(channelName: string): void {
  const tabName = `${channelName} (running)`;
  const newName = `${channelName} (stopped)`;
  const tmuxName = `claude-${channelName}`;

  // Update tmux window name if session still exists
  try {
    execSync(
      `${TMUX_PATH} rename-window -t "${tmuxName}" "${newName}" 2>/dev/null`,
      { timeout: 3000 }
    );
  } catch {
    // tmux session already dead, that's fine
  }

  if (!isItermRunning()) {
    return;
  }

  // Also update iTerm2 tab name via AppleScript
  const script = [
    'tell application "iTerm2"',
    "  repeat with w in windows",
    "    repeat with t in tabs of w",
    "      try",
    `        if name of current session of t is "${tabName}" then`,
    "          tell current session of t",
    `            set name to "${newName}"`,
    "          end tell",
    "        end if",
    "      end try",
    "    end repeat",
    "  end repeat",
    "end tell",
  ].join("\n");

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 5000,
    });
    console.log(`[iTerm2] Marked tab stopped for ${channelName}`);
  } catch (err) {
    console.error(
      `[iTerm2] Failed to mark tab stopped for ${channelName}:`,
      err
    );
  }
}
