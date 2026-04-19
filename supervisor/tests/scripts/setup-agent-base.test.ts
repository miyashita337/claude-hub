// Tests for scripts/setup-agent-base.sh — verifies fail-fast guards, logging to
// ~/.claude/logs, and the background-launch marker in .claude/settings.json.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
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

  test("script never embeds GH_TOKEN in the clone URL (ps/leak guard)", () => {
    // `https://x-access-token:${GH_TOKEN}@...` の URL 埋め込み書き方が
    // 戻っていないことを静的に検証（base64 経由なら OK）
    const src = readFileSync(SCRIPT_PATH, "utf8");
    expect(src).not.toMatch(/https:\/\/x-access-token:\$\{?GH_TOKEN/);
    // 代わりに http.extraheader 経由で認証していることを確認
    expect(src).toContain("GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'");
  });

  test("log file is rotated to .1 when it exceeds the size threshold", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "setup-agent-base-"));
    tmpHomes.push(home);
    const logDir = resolve(home, ".claude/logs");
    const logFile = resolve(logDir, "setup-agent-base.log");
    mkdirSync(logDir, { recursive: true });
    // 閾値を 100 byte に下げ、それ以上の既存ログを置く
    const bigLog = "x".repeat(200);
    writeFileSync(logFile, bigLog, "utf8");
    const r = await run(
      { CLAUDE_CODE_REMOTE: "", GH_TOKEN: "", SETUP_AGENT_BASE_LOG_MAX_BYTES: "100" },
      home,
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(resolve(logDir, "setup-agent-base.log.1"))).toBe(true);
    // 新規ログには skip 行のみ、古い `xxx...` は入っていない
    const newLog = readFileSync(logFile, "utf8");
    expect(newLog).toContain("step: skip");
    expect(newLog).not.toContain(bigLog);
  });

  test("backup name includes PID to avoid same-second collisions", () => {
    const src = readFileSync(SCRIPT_PATH, "utf8");
    // `.bak.<timestamp>.$$` パターン（PID 付き）になっていること
    expect(src).toMatch(/\.bak\.\$\(date -u \+%Y%m%d%H%M%S\)\.\$\$/);
  });
});
