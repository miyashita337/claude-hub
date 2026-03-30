# Hook + HTTP Relay 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** capture-pane ポーリングを廃止し、Claude Code の Stop フック + HTTP POST で応答を取得する方式に書き換える

**Architecture:** Supervisor が Bun.serve で HTTP Relay サーバーを起動し、Claude Code の Stop フックが各ターン完了時に `last_assistant_message` を POST する。Supervisor は Promise で待ち受け、HTTP POST を受信したら Discord に応答を投稿する。入力は従来通り tmux send-keys。

**Tech Stack:** Bun (Bun.serve, bun:test), TypeScript, tmux, Claude Code Stop hook (bash + curl + jq)

**設計書:** `docs/superpowers/specs/2026-03-30-hook-http-relay-design.md`

---

## ファイル構成

| ファイル | 操作 | 責務 |
|---|---|---|
| `src/session/relay-server.ts` | 新規 | Bun.serve HTTP サーバー。`POST /relay/:threadId` を受信し、pending Promise を resolve |
| `hooks/stop-relay.sh` | 新規 | Claude Code Stop フックスクリプト。stdin の JSON から応答を抽出し curl POST |
| `src/session/relay.ts` | 全面書き換え | capture-pane 全削除。send-keys + Promise ベースの応答待機 |
| `src/session/manager.ts` | 修正 | `SUPERVISOR_RELAY_URL` 環境変数を tmux に渡す。relay-server の起動/停止 |
| `src/bot.ts` | 修正 | relay-server 起動を SessionManager 経由で呼び出し |
| `tests/session/relay-server.test.ts` | 新規 | relay-server のユニットテスト |
| `tests/session/relay.test.ts` | 書き換え | 新 relay のユニットテスト |
| `tests/session/relay-internals.test.ts` | 削除 | isAtPrompt/extractResponse のテスト（関数ごと削除） |
| `tests/hooks/stop-relay.test.ts` | 新規 | Stop フックスクリプトのテスト |

---

### Task 1: relay-server — HTTP Relay サーバー

**Files:**
- Create: `supervisor/src/session/relay-server.ts`
- Test: `supervisor/tests/session/relay-server.test.ts`

- [ ] **Step 1: テストファイル作成（RED）**

```typescript
// supervisor/tests/session/relay-server.test.ts
import { test, expect, describe, afterEach } from "bun:test";
import {
  startRelayServer,
  stopRelayServer,
  waitForRelay,
  getRelayPort,
} from "../../src/session/relay-server";

describe("relay-server", () => {
  afterEach(() => {
    stopRelayServer();
  });

  test("startRelayServer starts HTTP server on configured port", async () => {
    startRelayServer();
    const port = getRelayPort();
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
  });

  test("POST /relay/:threadId resolves pending promise", async () => {
    startRelayServer();
    const port = getRelayPort();

    const promise = waitForRelay("thread-abc", 5000);

    await fetch(`http://localhost:${port}/relay/thread-abc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Hello from Claude",
        session_id: "sess-123",
      }),
    });

    const result = await promise;
    expect(result.text).toBe("Hello from Claude");
    expect(result.claudeSessionId).toBe("sess-123");
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("waitForRelay times out if no POST received", async () => {
    startRelayServer();

    const result = await waitForRelay("thread-timeout", 100);
    expect(result.error).toBe("Response timeout");
  });

  test("POST to unknown threadId returns 404", async () => {
    startRelayServer();
    const port = getRelayPort();

    // No pending promise for this thread
    const res = await fetch(`http://localhost:${port}/relay/unknown-thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });
    expect(res.status).toBe(404);
  });

  test("stopRelayServer stops the server", async () => {
    startRelayServer();
    const port = getRelayPort();
    stopRelayServer();

    try {
      await fetch(`http://localhost:${port}/health`);
      expect(true).toBe(false); // Should not reach here
    } catch {
      // Connection refused — expected
      expect(true).toBe(true);
    }
  });

  test("multiple threads can wait concurrently", async () => {
    startRelayServer();
    const port = getRelayPort();

    const promise1 = waitForRelay("thread-1", 5000);
    const promise2 = waitForRelay("thread-2", 5000);

    await fetch(`http://localhost:${port}/relay/thread-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Response 2", session_id: "s2" }),
    });

    await fetch(`http://localhost:${port}/relay/thread-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Response 1", session_id: "s1" }),
    });

    const result1 = await promise1;
    const result2 = await promise2;
    expect(result1.text).toBe("Response 1");
    expect(result2.text).toBe("Response 2");
  });
});
```

- [ ] **Step 2: テスト実行（FAIL 確認）**

Run: `cd supervisor && bun test tests/session/relay-server.test.ts`
Expected: FAIL — module `relay-server` not found

- [ ] **Step 3: relay-server 実装**

```typescript
// supervisor/src/session/relay-server.ts
import { formatForDiscord } from "./output-formatter";

export interface RelayResult {
  text: string;
  chunks: string[];
  claudeSessionId?: string;
  error?: string;
}

interface PendingRequest {
  resolve: (result: RelayResult) => void;
  timer: Timer;
}

const pendingRequests = new Map<string, PendingRequest>();

let server: ReturnType<typeof Bun.serve> | null = null;
let relayPort = 0;

const DEFAULT_PORT = parseInt(process.env.RELAY_PORT ?? "0", 10);

export function startRelayServer(): void {
  if (server) return;

  server = Bun.serve({
    port: DEFAULT_PORT, // 0 = random available port
    fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") {
        return new Response("ok");
      }

      // POST /relay/:threadId
      if (req.method === "POST" && url.pathname.startsWith("/relay/")) {
        return handleRelayPost(req, url);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  relayPort = server.port;
  console.log(`[RelayServer] Started on port ${relayPort}`);
}

async function handleRelayPost(
  req: Request,
  url: URL
): Promise<Response> {
  const threadId = url.pathname.slice("/relay/".length);
  const pending = pendingRequests.get(threadId);

  if (!pending) {
    return new Response("No pending request for this thread", { status: 404 });
  }

  try {
    const body = await req.json();
    const text = body.text ?? body.last_assistant_message ?? "";

    clearTimeout(pending.timer);
    pending.resolve({
      text,
      chunks: formatForDiscord(text),
      claudeSessionId: body.session_id ?? undefined,
    });
    pendingRequests.delete(threadId);

    return new Response("ok");
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
}

export function waitForRelay(
  threadId: string,
  timeoutMs: number
): Promise<RelayResult> {
  return new Promise<RelayResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(threadId);
      resolve({
        text: "",
        chunks: ["⚠️ Claude Code からの応答がタイムアウトしました。"],
        error: "Response timeout",
      });
    }, timeoutMs);

    pendingRequests.set(threadId, { resolve, timer });
  });
}

export function cancelRelay(threadId: string): void {
  const pending = pendingRequests.get(threadId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRequests.delete(threadId);
  }
}

export function getRelayPort(): number {
  return relayPort;
}

export function stopRelayServer(): void {
  if (server) {
    server.stop(true);
    server = null;
    relayPort = 0;
  }
  // Clean up pending requests
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer);
  }
  pendingRequests.clear();
}
```

- [ ] **Step 4: テスト実行（GREEN 確認）**

Run: `cd supervisor && bun test tests/session/relay-server.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: コミット**

```bash
git add supervisor/src/session/relay-server.ts supervisor/tests/session/relay-server.test.ts
git commit -m "feat(relay): add HTTP relay server with Bun.serve

Receives Stop hook POSTs at /relay/:threadId and resolves
pending promises. Supports concurrent threads and timeout."
```

---

### Task 2: Stop フックスクリプト

**Files:**
- Create: `supervisor/hooks/stop-relay.sh`
- Test: `supervisor/tests/hooks/stop-relay.test.ts`

- [ ] **Step 1: テストファイル作成（RED）**

```typescript
// supervisor/tests/hooks/stop-relay.test.ts
import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/stop-relay.sh");

describe("stop-relay.sh", () => {
  test("exits silently when SUPERVISOR_RELAY_URL is not set", async () => {
    const result = await $`echo '{"last_assistant_message":"hello"}' | env -i bash ${HOOK_PATH}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });

  test("sends POST with text from last_assistant_message", async () => {
    // Start a simple listener to capture the POST
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        return new Response(JSON.stringify(body));
      },
    });

    try {
      const url = `http://localhost:${server.port}/relay/test-thread`;
      const input = JSON.stringify({
        last_assistant_message: "Hello from Claude",
        session_id: "sess-abc",
      });

      const result = await $`echo ${input} | SUPERVISOR_RELAY_URL=${url} bash ${HOOK_PATH}`.quiet().nothrow();
      expect(result.exitCode).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("exits gracefully when last_assistant_message is empty", async () => {
    const input = JSON.stringify({ session_id: "sess-abc" });
    const result = await $`echo ${input} | SUPERVISOR_RELAY_URL=http://localhost:9999/relay/t env -i PATH=$PATH bash ${HOOK_PATH}`.quiet().nothrow();
    // Should exit 0 (skips curl when text is empty)
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: テスト実行（FAIL 確認）**

Run: `cd supervisor && bun test tests/hooks/stop-relay.test.ts`
Expected: FAIL — hook script not found

- [ ] **Step 3: Stop フックスクリプト作成**

```bash
#!/bin/bash
# supervisor/hooks/stop-relay.sh
# Claude Code Stop hook: POSTs the assistant response to Supervisor's HTTP relay.
# Called with JSON on stdin containing last_assistant_message and session_id.
# Requires: SUPERVISOR_RELAY_URL environment variable.

if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0
fi

INPUT=$(cat)
TEXT=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$TEXT" ]; then
  exit 0
fi

curl -s -X POST "$SUPERVISOR_RELAY_URL" \
  -H "Content-Type: application/json" \
  -d "{\"text\": $(echo "$TEXT" | jq -Rs .), \"session_id\": \"$SESSION_ID\"}" \
  --max-time 5 \
  > /dev/null 2>&1

exit 0
```

- [ ] **Step 4: 実行権限付与**

Run: `chmod +x supervisor/hooks/stop-relay.sh`

- [ ] **Step 5: テスト実行（GREEN 確認）**

Run: `cd supervisor && bun test tests/hooks/stop-relay.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 6: コミット**

```bash
git add supervisor/hooks/stop-relay.sh supervisor/tests/hooks/stop-relay.test.ts
git commit -m "feat(relay): add Stop hook script for HTTP relay

Reads last_assistant_message from stdin JSON and POSTs to
SUPERVISOR_RELAY_URL. No-op when env var is unset."
```

---

### Task 3: relay.ts — capture-pane 削除 + Promise ベース書き換え

**Files:**
- Rewrite: `supervisor/src/session/relay.ts`
- Rewrite: `supervisor/tests/session/relay.test.ts`
- Delete: `supervisor/tests/session/relay-internals.test.ts`

- [ ] **Step 1: 旧テスト削除**

Run: `rm supervisor/tests/session/relay-internals.test.ts`

- [ ] **Step 2: 新テストファイル作成（RED）**

```typescript
// supervisor/tests/session/relay.test.ts
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  startRelayServer,
  stopRelayServer,
  getRelayPort,
} from "../../src/session/relay-server";

describe("relayMessage", () => {
  beforeAll(() => {
    startRelayServer();
  });

  afterAll(() => {
    stopRelayServer();
  });

  test("module exports relayMessage function", async () => {
    const relay = await import("../../src/session/relay");
    expect(typeof relay.relayMessage).toBe("function");
  });

  test("relayMessage signature accepts threadId parameter", async () => {
    const relay = await import("../../src/session/relay");
    // Verify function accepts (tmuxSessionName, threadId, message, options?)
    expect(relay.relayMessage.length).toBeGreaterThanOrEqual(3);
  });

  test("AttachmentInfo type is exported", async () => {
    const relay = await import("../../src/session/relay");
    // Type check — if this compiles, the type exists
    expect(relay).toBeDefined();
  });
});
```

- [ ] **Step 3: relay.ts 全面書き換え**

```typescript
// supervisor/src/session/relay.ts
import { execSync } from "child_process";
import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { waitForRelay } from "./relay-server";

const TMUX_PATH = process.env.TMUX_PATH ?? "/opt/homebrew/bin/tmux";
const ATTACHMENT_DIR = resolve(homedir(), "claude-hub", "tmp", "attachments");

/** How long to wait for Claude Code Stop hook to fire (ms) */
const RELAY_TIMEOUT_MS = 5 * 60_000;

export interface AttachmentInfo {
  url: string;
  filename: string;
  contentType: string;
}

export interface RelayResult {
  text: string;
  chunks: string[];
  claudeSessionId?: string;
  error?: string;
}

/**
 * Download a Discord attachment to a local temp file.
 */
async function downloadAttachment(attachment: AttachmentInfo): Promise<string> {
  mkdirSync(ATTACHMENT_DIR, { recursive: true });
  const localPath = resolve(ATTACHMENT_DIR, `${Date.now()}-${attachment.filename}`);

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(localPath, buffer);
  return localPath;
}

/**
 * Send a message to Claude Code via tmux send-keys and wait for
 * the response via HTTP relay (Stop hook POST).
 */
export async function relayMessage(
  tmuxSessionName: string,
  threadId: string,
  message: string,
  options?: { attachments?: AttachmentInfo[] }
): Promise<RelayResult> {
  // 1. Download attachments
  const localFiles: string[] = [];
  let fullMessage = message;

  if (options?.attachments?.length) {
    for (const att of options.attachments) {
      try {
        const localPath = await downloadAttachment(att);
        localFiles.push(localPath);
      } catch (err) {
        console.error(`[Relay] Failed to download attachment ${att.filename}:`, err);
      }
    }

    if (localFiles.length > 0) {
      const imageInstructions = localFiles
        .map((f) => `Read the image at ${f}`)
        .join(", and ");
      fullMessage = `${imageInstructions}. ${message}`;
    }
  }

  // 2. Escape and send via tmux send-keys
  const escaped = fullMessage
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");

  try {
    execSync(
      `${TMUX_PATH} send-keys -t "${tmuxSessionName}" "${escaped}" Enter`,
      { timeout: 5000 }
    );
  } catch (err) {
    scheduleCleanup(localFiles, 5 * 60_000);
    return {
      text: "",
      chunks: [`⚠️ Claude Code へのメッセージ送信に失敗: ${err}`],
      error: String(err),
    };
  }

  // 3. Wait for Stop hook to POST the response
  const result = await waitForRelay(threadId, RELAY_TIMEOUT_MS);

  scheduleCleanup(localFiles, 5 * 60_000);
  return result;
}

/**
 * Schedule file cleanup after a delay.
 */
function scheduleCleanup(files: string[], delayMs: number): void {
  if (files.length === 0) return;
  setTimeout(() => {
    for (const filePath of files) {
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore
      }
    }
  }, delayMs);
}
```

- [ ] **Step 4: テスト実行（GREEN 確認）**

Run: `cd supervisor && bun test tests/session/relay.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: コミット**

```bash
git rm supervisor/tests/session/relay-internals.test.ts
git add supervisor/src/session/relay.ts supervisor/tests/session/relay.test.ts
git commit -m "refactor(relay): replace capture-pane with Promise-based HTTP relay

Delete isAtPrompt, extractResponse, capturePaneContent, and the
polling loop. relayMessage now sends via tmux send-keys and waits
for the Stop hook HTTP POST via waitForRelay."
```

---

### Task 4: manager.ts — relay-server 起動 + SUPERVISOR_RELAY_URL 注入

**Files:**
- Modify: `supervisor/src/session/manager.ts`
- Modify: `supervisor/tests/session/manager.test.ts`

- [ ] **Step 1: manager テスト追加（RED）**

`manager.test.ts` に以下を追記:

```typescript
test("sendMessage passes threadId to relayMessage", async () => {
  const config = CHANNEL_MAP.get("oci-develop")!;
  const threadId = "thread-relay-test";
  manager.start(config, threadId);

  // sendMessage should not throw for signature mismatch
  // (actual relay will fail without tmux, but signature is correct)
  try {
    await manager.sendMessage(threadId, "test message");
  } catch {
    // Expected: tmux session doesn't actually exist in test
  }
});
```

- [ ] **Step 2: テスト実行（RED 確認）**

Run: `cd supervisor && bun test tests/session/manager.test.ts`
Expected: 新テストが追加されたことを確認（既存テストは PASS）

- [ ] **Step 3: manager.ts 修正**

修正内容:
1. `startRelayServer` / `stopRelayServer` / `getRelayPort` を import
2. constructor で `startRelayServer()` を呼ぶ
3. `start()` で Claude Code 起動コマンドに `SUPERVISOR_RELAY_URL` と Stop フック設定を追加
4. `sendMessage()` で `relayMessage` に `threadId` を渡す
5. `shutdownAll()` で `stopRelayServer()` を呼ぶ

```typescript
// manager.ts の変更箇所

// import 追加
import {
  startRelayServer,
  stopRelayServer,
  getRelayPort,
} from "./relay-server";

// constructor 変更
constructor() {
  startRelayServer();
  this.recoverFromDb();
}

// start() — claudeCmd の構築部分を変更
const relayUrl = `http://localhost:${getRelayPort()}/relay/${thread.id}`;
const hookPath = resolve(homedir(), "claude-hub", "supervisor", "hooks", "stop-relay.sh");
const claudeCmd = [
  "unset ANTHROPIC_API_KEY",
  `export PATH="${resolve(homedir(), ".local/bin")}:${resolve(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
  `export SUPERVISOR_RELAY_URL="${relayUrl}"`,
  `cd "${config.dir}"`,
  `exec ${CLAUDE_PATH} --dangerously-skip-permissions --name "${config.channelName}"`,
].join(" && ");

// sendMessage() — threadId を relayMessage に渡す
async sendMessage(
  threadId: string,
  message: string,
  attachments?: AttachmentInfo[]
): Promise<RelayResult> {
  // ... (既存の session 取得・alive チェック)
  return relayMessage(tmuxName, threadId, message, { attachments });
}

// shutdownAll() に追加
async shutdownAll(): Promise<void> {
  // ... (既存の全セッション停止)
  stopRelayServer();
}
```

- [ ] **Step 4: テスト実行（GREEN 確認）**

Run: `cd supervisor && bun test tests/session/manager.test.ts`
Expected: All tests PASS（新テスト含む）

- [ ] **Step 5: コミット**

```bash
git add supervisor/src/session/manager.ts supervisor/tests/session/manager.test.ts
git commit -m "feat(relay): integrate relay-server into SessionManager

Start relay server in constructor, inject SUPERVISOR_RELAY_URL
into tmux env, pass threadId to relayMessage, stop server on
shutdown."
```

---

### Task 5: bot.ts — 不要コード削除

**Files:**
- Modify: `supervisor/src/bot.ts`

- [ ] **Step 1: bot.ts の変更確認**

`relayMessage` のシグネチャが変わったので、`sendMessage` 側で吸収済み。
`bot.ts` 側の変更は最小限:
- `import type { AttachmentInfo } from "./session/relay"` はそのまま維持
- `sessionManager.sendMessage()` の呼び出しは変更不要（manager が吸収）

実際に変更が必要か確認:

Run: `cd supervisor && bun test`
Expected: 全テスト PASS。bot.ts の変更が不要なら次の Task へ。

- [ ] **Step 2: （必要な場合のみ）bot.ts の修正とコミット**

```bash
git add supervisor/src/bot.ts
git commit -m "chore(bot): update imports for new relay interface"
```

---

### Task 6: session.ts — Claude Session ID 表示

**Files:**
- Modify: `supervisor/src/commands/session.ts`
- Modify: `supervisor/src/bot.ts` (ウェルカムメッセージに session_id 追加)

- [ ] **Step 1: bot.ts — 初回応答時に claudeSessionId を DB 保存**

`MessageCreate` ハンドラで、`result.claudeSessionId` が返ってきたら DB に保存:

```typescript
// bot.ts の MessageCreate ハンドラ内、relay 結果取得後に追加
if (result.claudeSessionId) {
  const session = sessionManager.get(threadId);
  if (session && !session.claudeSessionId) {
    session.claudeSessionId = result.claudeSessionId;
    updateSessionClaudeId(session.id, result.claudeSessionId);
  }
}
```

import 追加: `import { updateSessionClaudeId } from "./infra/db";`

- [ ] **Step 2: session.ts — list コマンドに session_id 表示**

`handleList()` の embed フィールドに追加:

```typescript
embed.addFields({
  name: `#${session.channelName}`,
  value:
    `📁 \`${session.projectDir}\`\n` +
    `🧵 スレッド: <#${session.threadId}>\n` +
    (session.claudeSessionId ? `🔑 Session: \`${session.claudeSessionId.slice(0, 8)}...\`\n` : "") +
    `⏱️ 稼働: ${uptime} | 無操作: ${idle}`,
  inline: false,
});
```

- [ ] **Step 3: テスト実行**

Run: `cd supervisor && bun test`
Expected: All tests PASS

- [ ] **Step 4: コミット**

```bash
git add supervisor/src/bot.ts supervisor/src/commands/session.ts
git commit -m "feat(session): save and display Claude session ID

Store claudeSessionId from first relay response in DB.
Show truncated session ID in /session list embed."
```

---

### Task 7: Claude Code の hooks 設定（手動手順）

**Files:**
- Reference: `supervisor/hooks/stop-relay.sh`

- [ ] **Step 1: Claude Code の settings.json に Stop フック登録**

Claude Code の設定ファイル `~/.claude/settings.json` に Stop フックを追加する。
ただし、`SUPERVISOR_RELAY_URL` が設定されている場合のみ発火するので、通常利用に影響なし。

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash /Users/harieshokunin/claude-hub/supervisor/hooks/stop-relay.sh"
          }
        ]
      }
    ]
  }
}
```

注意: この設定は Supervisor 管理下の Claude Code セッション**すべて**に影響するが、スクリプトが `SUPERVISOR_RELAY_URL` 未設定で即 exit するため安全。

- [ ] **Step 2: jq がインストール済みか確認**

Run: `which jq`
Expected: `/opt/homebrew/bin/jq` or similar path

---

### Task 8: 全テスト実行 + pre-git-check

- [ ] **Step 1: 全テスト実行**

Run: `cd supervisor && bun test`
Expected: All tests PASS, 0 failures

- [ ] **Step 2: pre-git-check**

Run: `make pre-git-check`
Expected: PASS

- [ ] **Step 3: 不要ファイルの確認**

確認事項:
- `relay-internals.test.ts` が削除されていること
- `relay.ts` に `capturePaneContent`, `isAtPrompt`, `extractResponse` が残っていないこと
- `output-formatter.ts` はそのまま維持（`formatForDiscord` は relay-server から使用）

---

### Task 9: E2E テスト（Supervisor 起動 → Discord → 応答確認）

- [ ] **Step 1: Supervisor Bot 起動**

Run: `cd supervisor && bun run index.ts`
Expected: `[Bot] Logged in as ...` + `[RelayServer] Started on port ...`

- [ ] **Step 2: Discord でセッション起動**

Discord で `/session start` → スレッド作成確認

- [ ] **Step 3: メッセージ送信 → 応答確認**

スレッドに「pwd」と送信 → Claude Code が応答 → Discord に投稿されることを確認

- [ ] **Step 4: 画像添付テスト**

画像をスレッドに投稿 → 「この画像を説明してください」 → 応答確認

- [ ] **Step 5: セッション停止**

`/session stop` → セッション停止確認

---

### Task 10: PR 作成

- [ ] **Step 1: ブランチ確認**

Run: `git log --oneline main..HEAD`
Expected: Task 1-6 のコミットが表示

- [ ] **Step 2: PR 作成**

```bash
gh pr create \
  --title "feat: replace capture-pane with Stop hook + HTTP relay" \
  --body "$(cat <<'EOF'
## Summary
- capture-pane ポーリングを完全廃止し、Claude Code Stop フック + HTTP POST で応答を取得
- Bun.serve で Relay HTTP サーバーを起動、Promise ベースで応答待機
- isAtPrompt / extractResponse / capturePaneContent を全削除

## Architecture
Discord → tmux send-keys → Claude Code → Stop hook → HTTP POST → Supervisor → Discord

## Changes
- New: `src/session/relay-server.ts` — HTTP relay server
- New: `hooks/stop-relay.sh` — Stop hook script
- Rewrite: `src/session/relay.ts` — Promise-based relay
- Modify: `src/session/manager.ts` — relay-server integration
- Modify: `src/bot.ts` — claudeSessionId saving
- Delete: `isAtPrompt`, `extractResponse`, `capturePaneContent`

## Test plan
- [ ] Unit tests for relay-server (6 tests)
- [ ] Unit tests for stop-relay.sh (3 tests)
- [ ] Unit tests for relay.ts (3 tests)
- [ ] E2E: /session start → message → response → /session stop
- [ ] E2E: image attachment relay
EOF
)"
```
