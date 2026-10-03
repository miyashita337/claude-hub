import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// Issue #488: 離席中のツール実行許可を iPhone から承認/拒否する hook
const HOOK_PATH = resolve(import.meta.dir, "../../hooks/remote-approve-permission.sh");

let root: string;
let scripts: string;
let permDir: string;
let notifyLog: string;

/**
 * Fake agent-base scripts. The fake notify-once records each call and, to stand
 * in for the phone tap, writes FAKE_DECISION into <id>.decision right away.
 */
function makeFakeScripts() {
  scripts = join(root, "scripts");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  writeFileSync(
    join(scripts, "lib", "keychain-get.sh"),
    'keychain_get() { [ "$1" = pushover-action-receiver-url ] && echo "http://100.80.156.14:8317/act"; }\n'
  );
  writeFileSync(join(scripts, "lib", "action-token.sh"), 'echo "tok-$1"\n');
  writeFileSync(
    join(scripts, "lib", "notify-once.sh"),
    [
      "#!/bin/bash",
      'printf "%s\\t%s\\t%s\\n" "$1" "$3" "$7" >> "$NOTIFY_LOG"',
      '[ -n "${FAKE_NOTIFY_RC:-}" ] && exit "$FAKE_NOTIFY_RC"',
      '[ -n "${FAKE_DECISION:-}" ] && printf "%s" "$FAKE_DECISION" > "$PERM_REQUEST_DIR/$1.decision"',
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(join(scripts, "lib", "notify-once.sh"), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "remote-approve-"));
  permDir = join(root, "perm");
  notifyLog = join(root, "notify.log");
  makeFakeScripts();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const INPUT = JSON.stringify({
  tool_name: "Bash",
  tool_input: { command: "rm -r build <dist>" },
  cwd: "/Users/x/proj",
});

async function runHook(env: Record<string, string>) {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    AGENT_BASE_SCRIPTS: scripts,
    PERM_REQUEST_DIR: permDir,
    NOTIFY_LOG: notifyLog,
    REMOTE_APPROVE_LOG: join(root, "hook.log"),
    REMOTE_APPROVE_IDLE_CMD: "echo 600",
    REMOTE_APPROVE_POLL_SEC: "0.2",
  };
  const merged = { ...base, ...env };
  return await $`echo ${INPUT} | bash ${HOOK_PATH}`.env(merged).quiet().nothrow();
}

function notifyCount(): number {
  if (!existsSync(notifyLog)) return 0;
  return readFileSync(notifyLog, "utf8").split("\n").filter(Boolean).length;
}

describe("remote-approve-permission.sh", () => {
  test("supervisor sessions are left to auto-approve (no output, no notify)", async () => {
    const r = await runHook({ SUPERVISOR_RELAY_URL: "http://localhost:1/relay" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(notifyCount()).toBe(0);
  });

  test("at the Mac (recent input) → normal dialog, no notify", async () => {
    const r = await runHook({ REMOTE_APPROVE_IDLE_CMD: "echo 10" });
    expect(r.stdout.toString()).toBe("");
    expect(notifyCount()).toBe(0);
  });

  test("away + tapped approve → allow, one notification with the approve link", async () => {
    const r = await runHook({ FAKE_DECISION: "allow" });
    const out = JSON.parse(r.stdout.toString());
    expect(out.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(out.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(notifyCount()).toBe(1);
    const [id, title, action] = readFileSync(notifyLog, "utf8").trim().split("\t");
    expect(id).toMatch(/^req-[0-9a-f]{16}$/);
    expect(title).toContain("Bash");
    expect(action).toBe(`perm-allow:${id}`);
    // 待ちファイルは片付ける
    expect(readdirSync(permDir)).toEqual([]);
  });

  test("away + tapped deny → deny with a message", async () => {
    const r = await runHook({ FAKE_DECISION: "deny" });
    const out = JSON.parse(r.stdout.toString());
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(out.hookSpecificOutput.decision.message).toContain("iPhone");
  });

  test("notification not sent (duplicate / rate limited) → give up immediately", async () => {
    const started = Date.now();
    const r = await runHook({ FAKE_NOTIFY_RC: "10", REMOTE_APPROVE_WAIT_SEC: "30" });
    expect(r.stdout.toString()).toBe("");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("no answer → times out without deciding, notified exactly once", async () => {
    const r = await runHook({ REMOTE_APPROVE_WAIT_SEC: "2" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(notifyCount()).toBe(1);
    expect(readdirSync(permDir)).toEqual([]);
  });

  test("user comes back to the Mac while waiting → stop waiting", async () => {
    const counter = join(root, "idle-count");
    // 1 回目は離席 (600 秒)、2 回目以降は在席 (5 秒)
    const idleCmd = `if [ -f ${counter} ]; then echo 5; else touch ${counter}; echo 600; fi`;
    const started = Date.now();
    const r = await runHook({ REMOTE_APPROVE_IDLE_CMD: idleCmd, REMOTE_APPROVE_WAIT_SEC: "30" });
    expect(r.stdout.toString()).toBe("");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("REMOTE_APPROVE=0 opts out", async () => {
    const r = await runHook({ REMOTE_APPROVE: "0", FAKE_DECISION: "allow" });
    expect(r.stdout.toString()).toBe("");
    expect(notifyCount()).toBe(0);
  });
});

describe("remote-approve-permission.sh idle detection while waiting", () => {
  test("idle time becomes unreadable while waiting → stop waiting (CodeRabbit #489)", async () => {
    const counter = join(root, "idle-count2");
    const idleCmd = `if [ -f ${counter} ]; then echo oops; else touch ${counter}; echo 600; fi`;
    const started = Date.now();
    const r = await runHook({ REMOTE_APPROVE_IDLE_CMD: idleCmd, REMOTE_APPROVE_WAIT_SEC: "30" });
    expect(r.stdout.toString()).toBe("");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
