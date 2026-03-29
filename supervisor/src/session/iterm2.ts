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
  const r = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hueToRgb(p, q, h) * 255);
  const b = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);
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
    const result = execSync(
      `osascript -e 'tell app "System Events" to (name of processes) contains "iTerm2"'`,
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    return result === "true";
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
