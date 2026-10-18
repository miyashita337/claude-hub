import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// Issue #519: supervisor 外のセッションの AskUserQuestion を iPhone で答える。
// 入口は既存の PreToolUse hook（ask-user-relay.sh）で、supervisor でないと分かった時点で
// ask-user-remote.sh に渡す。実際の配線と同じく ask-user-relay.sh から呼ぶ。
const RELAY_HOOK = resolve(import.meta.dir, "../../hooks/ask-user-relay.sh");
const REMOTE_APPROVE_HOOK = resolve(import.meta.dir, "../../hooks/remote-approve-permission.sh");

let root: string;
let scripts: string;
let permDir: string;
let notifyLog: string;

/**
 * Fake agent-base scripts. The fake notify-once records the call (id, body) and,
 * to stand in for the phone answer, writes FAKE_ANSWER into <id>.answer.
 */
function makeFakeScripts() {
  scripts = join(root, "scripts");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  writeFileSync(
    join(scripts, "lib", "keychain-get.sh"),
    'keychain_get() { [ "$1" = pushover-action-receiver-url ] && echo "http://100.80.156.14:8317/act"; }\n'
  );
  writeFileSync(join(scripts, "lib", "action-token.sh"), 'echo "tok-$1-$2"\n');
  writeFileSync(
    join(scripts, "lib", "notify-once.sh"),
    [
      "#!/bin/bash",
      'printf "%s\\t%s\\t%s\\n" "$1" "$3" "$(printf "%s" "$4" | tr "\\n" "|")" >> "$NOTIFY_LOG"',
      'cp "$PERM_REQUEST_DIR/$1.pending" "$NOTIFY_LOG.pending"',
      '[ -n "${FAKE_NOTIFY_RC:-}" ] && exit "$FAKE_NOTIFY_RC"',
      '[ -n "${FAKE_ANSWER:-}" ] && printf "%s" "$FAKE_ANSWER" > "$PERM_REQUEST_DIR/$1.answer"',
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(join(scripts, "lib", "notify-once.sh"), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ask-remote-"));
  permDir = join(root, "perm");
  notifyLog = join(root, "notify.log");
  makeFakeScripts();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TOOL_INPUT = {
  questions: [
    {
      question: "A か B か？",
      header: "選択",
      multiSelect: false,
      options: [
        { label: "A", description: "<案 A>" },
        { label: "B", description: "案 B" },
      ],
    },
  ],
};
const INPUT = JSON.stringify({
  session_id: "11111111-2222-3333-4444-555555555555",
  tool_name: "AskUserQuestion",
  tool_input: TOOL_INPUT,
  cwd: "/Users/x/proj",
});

async function runHook(env: Record<string, string>) {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    // ask-user-relay.sh の supervisor 判定ファイルを探す場所（無い = supervisor 外）
    XDG_RUNTIME_DIR: join(root, "run"),
    AGENT_BASE_SESSION_RELAY: "1",
    AGENT_BASE_SCRIPTS: scripts,
    PERM_REQUEST_DIR: permDir,
    NOTIFY_LOG: notifyLog,
    REMOTE_APPROVE_LOG: join(root, "hook.log"),
    REMOTE_APPROVE_IDLE_CMD: "echo 600",
    REMOTE_APPROVE_POLL_SEC: "0.2",
  };
  return await $`echo ${INPUT} | bash ${RELAY_HOOK}`.env({ ...base, ...env }).quiet().nothrow();
}

function notifications(): string[][] {
  if (!existsSync(notifyLog)) return [];
  return readFileSync(notifyLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
}

function hookLog(): string {
  return existsSync(join(root, "hook.log")) ? readFileSync(join(root, "hook.log"), "utf8") : "";
}

describe("ask-user-remote.sh (via ask-user-relay.sh)", () => {
  test("answered from the phone → allow + updatedInput with the original questions and answers", async () => {
    const r = await runHook({ FAKE_ANSWER: JSON.stringify({ "A か B か？": "B" }) });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString());
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...TOOL_INPUT, answers: { "A か B か？": "B" } },
    });
    expect(readdirSync(permDir)).toEqual([]);
  });

  test("notification carries the question, numbered options and one answer link", async () => {
    await runHook({ FAKE_ANSWER: JSON.stringify({ "A か B か？": "A" }) });
    const sent = notifications();
    expect(sent.length).toBe(1);
    const [id, title, body] = sent[0]!;
    expect(id).toMatch(/^ask-[0-9a-f]{16}$/);
    expect(title).toContain("AskUserQuestion");
    expect(body!.startsWith("[選択] A か B か？")).toBe(true);
    expect(body).toContain(" 1. A — &lt;案 A&gt;");
    expect(body).toContain(" 2. B — 案 B");
    expect(body).toContain(`href="http://100.80.156.14:8317/act?t=tok-ask-answer-${id}"`);
    // 回答ページがフォームを組めるよう、questions がそのまま .pending に置かれている
    expect(JSON.parse(readFileSync(`${notifyLog}.pending`, "utf8"))).toEqual(TOOL_INPUT.questions);
    expect(hookLog()).toContain("tool=AskUserQuestion question=A か B か？");
  });

  test("no answer → times out and falls back to the TUI (no output)", async () => {
    const r = await runHook({ REMOTE_APPROVE_WAIT_SEC: "2" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(hookLog()).toContain("timeout id=");
    expect(readdirSync(permDir)).toEqual([]);
  });

  test("without the opt-in env → nothing happens (TUI as before)", async () => {
    const r = await runHook({ AGENT_BASE_SESSION_RELAY: "", FAKE_ANSWER: '{"A か B か？":"A"}' });
    expect(r.stdout.toString()).toBe("");
    expect(notifications().length).toBe(0);
  });

  test("at the Mac → no notification, logged as skip", async () => {
    const r = await runHook({ REMOTE_APPROVE_IDLE_CMD: "echo 10" });
    expect(r.stdout.toString()).toBe("");
    expect(notifications().length).toBe(0);
    expect(hookLog()).toContain("skip: at Mac (idle=10s");
  });

  test("notification not sent (duplicate / rate limited) → give up immediately", async () => {
    const started = Date.now();
    const r = await runHook({ FAKE_NOTIFY_RC: "10", REMOTE_APPROVE_WAIT_SEC: "30" });
    expect(r.stdout.toString()).toBe("");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("malformed answer file → no decision (TUI)", async () => {
    const r = await runHook({ FAKE_ANSWER: '["not","an","object"]' });
    expect(r.stdout.toString()).toBe("");
    expect(hookLog()).toContain("ignored malformed answer");
  });

  test("a long question is cut so the body stays within Pushover's 1024 chars", async () => {
    const long = JSON.stringify({
      session_id: "s",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "長".repeat(3000), options: [{ label: "A" }] }] },
      cwd: "/Users/x/proj",
    });
    await $`echo ${long} | bash ${RELAY_HOOK}`
      .env({
        PATH: process.env.PATH ?? "",
        HOME: root,
        XDG_RUNTIME_DIR: join(root, "run"),
        AGENT_BASE_SESSION_RELAY: "1",
        AGENT_BASE_SCRIPTS: scripts,
        PERM_REQUEST_DIR: permDir,
        NOTIFY_LOG: notifyLog,
        REMOTE_APPROVE_LOG: join(root, "hook.log"),
        REMOTE_APPROVE_IDLE_CMD: "echo 600",
        FAKE_ANSWER: "{}",
      })
      .quiet()
      .nothrow();
    const body = notifications()[0]![2]!;
    expect(body.length).toBeLessThan(1024);
    expect(body).toContain("…");
    expect(body).toContain("👉 回答する");
  });
});


// Issue #519: AskUserQuestion は承認／拒否では答えられない。opt-in のセッションでは
// PreToolUse の ask-user-remote.sh が中継するので、ここでは 2 通目を出さない
describe("remote-approve-permission.sh AskUserQuestion", () => {
  async function runAsk(env: Record<string, string>) {
    const input = JSON.stringify({ tool_name: "AskUserQuestion", tool_input: { questions: [] }, cwd: "/p" });
    return await $`echo ${input} | bash ${REMOTE_APPROVE_HOOK}`
      .env({
        PATH: process.env.PATH ?? "",
        HOME: root,
        AGENT_BASE_SCRIPTS: scripts,
        PERM_REQUEST_DIR: permDir,
        NOTIFY_LOG: notifyLog,
        REMOTE_APPROVE_LOG: join(root, "hook.log"),
        REMOTE_APPROVE_IDLE_CMD: "echo 600",
        REMOTE_APPROVE_POLL_SEC: "0.2",
        REMOTE_APPROVE_WAIT_SEC: "1",
        ...env,
      })
      .quiet()
      .nothrow();
  }

  test("opt-in session → skipped, no approve/deny notification", async () => {
    const r = await runAsk({ AGENT_BASE_SESSION_RELAY: "1" });
    expect(r.stdout.toString()).toBe("");
    expect(notifications().length).toBe(0);
    expect(readFileSync(join(root, "hook.log"), "utf8")).toContain("relayed by ask-user-remote.sh");
  });

  test("without the opt-in → unchanged (approve/deny notification as before)", async () => {
    await runAsk({});
    expect(notifications().length).toBe(1);
  });
});
