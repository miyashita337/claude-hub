// Tests for scripts/setup-agent-base.sh — verifies fail-fast guards, logging to
// ~/.claude/logs, and the background-launch marker in .claude/settings.json.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";

const SCRIPT_PATH = resolve(import.meta.dir, "../../../scripts/setup-agent-base.sh");
const SETTINGS_PATH = resolve(import.meta.dir, "../../../.claude/settings.json");

async function run(env: Record<string, string>, extraHome?: string) {
  const home = extraHome ?? mkdtempSync(resolve(tmpdir(), "setup-agent-base-"));
  // `&&` ではなく常に終了コードを取るため `;` で連結してから exit する
  const proc = Bun.spawn(["bash", SCRIPT_PATH], {
    env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const logFile = resolve(home, ".claude/logs/setup-agent-base.log");
  const logText = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  return { exitCode, home, logText };
}

describe("setup-agent-base.sh", () => {
  const tmpHomes: string[] = [];

  afterEach(() => {
    while (tmpHomes.length) {
      const h = tmpHomes.pop();
      if (h && existsSync(h)) rmSync(h, { recursive: true, force: true });
    }
  });

  test("exit 0 + skip log when CLAUDE_CODE_REMOTE is unset (local)", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "setup-agent-base-"));
    tmpHomes.push(home);
    const r = await run({ CLAUDE_CODE_REMOTE: "", GH_TOKEN: "" }, home);
    expect(r.exitCode).toBe(0);
    expect(r.logText).toContain("step: skip");
    // clone は行われない
    expect(existsSync(resolve(home, "agent-base"))).toBe(false);
  });

  test("exit 1 + ERROR log when GH_TOKEN is missing on remote", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "setup-agent-base-"));
    tmpHomes.push(home);
    const r = await run({ CLAUDE_CODE_REMOTE: "true", GH_TOKEN: "" }, home);
    expect(r.exitCode).toBe(1);
    expect(r.logText).toContain("ERROR: GH_TOKEN is not set");
    expect(existsSync(resolve(home, "agent-base"))).toBe(false);
  });

  test("log file is created under $HOME/.claude/logs", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "setup-agent-base-"));
    tmpHomes.push(home);
    await run({ CLAUDE_CODE_REMOTE: "", GH_TOKEN: "" }, home);
    expect(existsSync(resolve(home, ".claude/logs/setup-agent-base.log"))).toBe(true);
  });

  test("settings.json hook launches the script in the background", () => {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    const cmd = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
    // `&` による background 実行 + セッションブロック回避のためのリダイレクト
    expect(cmd).toContain("setup-agent-base.sh");
    expect(cmd.trimEnd().endsWith("&")).toBe(true);
  });
});
