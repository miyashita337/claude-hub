# Relay Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tmux capture-pane が応答抽出に失敗した場合、`claude -p --resume` で確実にリカバリするフォールバックを追加する。

**Architecture:** Phase 1 (tmux send-keys + capture-pane, 最大30秒) → Phase 2 (claude -p --resume --output-format json) のフォールバック方式。session ID を Discord スレッドに表示し、障害調査に使えるようにする。

**Tech Stack:** Bun, TypeScript, tmux, claude CLI, discord.js

---

### Task 1: Phase 2 フォールバック関数の実装

**Files:**
- Modify: `supervisor/src/session/relay.ts`
- Test: `supervisor/tests/session/relay-fallback.test.ts`

- [ ] **Step 1: Write the failing test for runClaudePrint**

```typescript
// supervisor/tests/session/relay-fallback.test.ts
import { test, expect, describe } from "bun:test";
import { runClaudePrint } from "../../src/session/relay";

describe("runClaudePrint", () => {
  test("module exports runClaudePrint function", () => {
    expect(typeof runClaudePrint).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPERVISOR_DB_PATH=":memory:" bun test tests/session/relay-fallback.test.ts`
Expected: FAIL — `runClaudePrint` not exported

- [ ] **Step 3: Implement runClaudePrint**

Add to `supervisor/src/session/relay.ts`:

```typescript
const CLAUDE_PATH = process.env.CLAUDE_PATH ?? resolve(homedir(), ".local", "bin", "claude");
const FALLBACK_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export interface FallbackResult {
  text: string;
  sessionId?: string;
  error?: string;
}

/**
 * Phase 2 fallback: Run claude -p with --resume to get a structured JSON response.
 */
export async function runClaudePrint(
  projectDir: string,
  message: string,
  claudeSessionId?: string,
  fileArgs?: string[]
): Promise<FallbackResult> {
  const args: string[] = [
    "-p",
    message,
    "--output-format", "json",
    "--dangerously-skip-permissions",
  ];

  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }

  if (fileArgs?.length) {
    for (const f of fileArgs) {
      args.push("--file", f);
    }
  }

  return new Promise<FallbackResult>((resolve) => {
    const proc = Bun.spawn([CLAUDE_PATH, ...args], {
      cwd: projectDir,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: undefined, // Use Claude Max subscription
        PATH: `${homedir()}/.local/bin:${homedir()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ text: "", error: "Fallback timeout" });
    }, FALLBACK_TIMEOUT_MS);

    proc.exited.then(async () => {
      clearTimeout(timeout);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (!stdout) {
        resolve({ text: "", error: stderr || "Empty stdout" });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          text: parsed.result || "",
          sessionId: parsed.session_id,
        });
      } catch {
        // Try stream-json parsing
        const { parseStreamJsonOutput } = await import("./output-formatter");
        resolve({
          text: parseStreamJsonOutput(stdout),
        });
      }
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPERVISOR_DB_PATH=":memory:" bun test tests/session/relay-fallback.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supervisor/src/session/relay.ts supervisor/tests/session/relay-fallback.test.ts
git commit -m "feat(relay): add runClaudePrint fallback function"
```

---

### Task 2: relayMessage に Phase 1 → Phase 2 フォールバックロジック追加

**Files:**
- Modify: `supervisor/src/session/relay.ts`
- Test: `supervisor/tests/session/relay-internals.test.ts`

- [ ] **Step 1: Modify relayMessage constants**

Change Phase 1 timeout from 5 minutes to 30 seconds:

```typescript
// At the top of relay.ts, change:
const PHASE1_TIMEOUT_MS = 30_000; // 30 seconds for capture-pane
const PHASE2_TIMEOUT_MS = 5 * 60_000; // 5 minutes for claude -p fallback
```

Replace `RESPONSE_START_TIMEOUT_MS` with `PHASE1_TIMEOUT_MS` for the prompt-ready-but-empty-response path.
Keep `RESPONSE_COMPLETE_TIMEOUT_MS` for the still-processing path.

- [ ] **Step 2: Add Phase 2 fallback in the "（応答なし）" path**

In `relayMessage`, replace the `"（応答なし）"` return block:

```typescript
      if (!responseText) {
        // Fallback: try with the full message
        const fallbackText = extractResponse(beforeContent, finalContent, fullMessage);
        if (fallbackText) {
          return { text: fallbackText, chunks: formatForDiscord(fallbackText) };
        }

        // Phase 2: claude -p fallback
        console.log(`[Relay] Phase 1 failed, falling back to claude -p`);
        const session = /* passed from caller */;
        const fallback = await runClaudePrint(
          session.projectDir,
          message,
          session.claudeSessionId,
          localFiles.length > 0 ? localFiles : undefined
        );

        scheduleCleanup(localFiles, 5 * 60_000);

        if (fallback.error) {
          return {
            text: "",
            chunks: [`⚠️ Phase 2 フォールバックも失敗: ${fallback.error}`],
            error: fallback.error,
          };
        }

        return {
          text: fallback.text,
          chunks: formatForDiscord(fallback.text || "（応答なし）"),
          claudeSessionId: fallback.sessionId,
        };
      }
```

- [ ] **Step 3: Update RelayResult to include claudeSessionId**

```typescript
export interface RelayResult {
  text: string;
  chunks: string[];
  error?: string;
  claudeSessionId?: string; // From Phase 2 JSON response
}
```

- [ ] **Step 4: Update relayMessage signature to accept session info**

```typescript
export async function relayMessage(
  tmuxSessionName: string,
  message: string,
  options?: {
    attachments?: AttachmentInfo[];
    projectDir?: string;
    claudeSessionId?: string;
  }
): Promise<RelayResult>
```

- [ ] **Step 5: Run all tests**

Run: `SUPERVISOR_DB_PATH=":memory:" bun test`
Expected: All pass (update any broken tests)

- [ ] **Step 6: Commit**

```bash
git add supervisor/src/session/relay.ts supervisor/tests/session/relay-internals.test.ts
git commit -m "feat(relay): add Phase 1 → Phase 2 fallback in relayMessage"
```

---

### Task 3: manager.ts の sendMessage を更新

**Files:**
- Modify: `supervisor/src/session/manager.ts`

- [ ] **Step 1: Pass session info to relayMessage**

In `sendMessage`, update the `relayMessage` call:

```typescript
  async sendMessage(
    threadId: string,
    message: string,
    attachments?: AttachmentInfo[]
  ): Promise<RelayResult> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`スレッド ${threadId} にセッションが見つかりません`);
    }

    session.lastActivityAt = new Date();
    updateSessionActivity(session.id);

    const tmuxName = this.tmuxSessionName(threadId);

    if (!this.isTmuxSessionAlive(tmuxName)) {
      return {
        text: "",
        chunks: ["⚠️ Claude Code セッションが終了しています。`/session start` で再起動してください。"],
        error: "tmux session dead",
      };
    }

    const result = await relayMessage(tmuxName, message, {
      attachments,
      projectDir: session.projectDir,
      claudeSessionId: session.claudeSessionId,
    });

    // Save claude session ID if obtained from Phase 2
    if (result.claudeSessionId && !session.claudeSessionId) {
      session.claudeSessionId = result.claudeSessionId;
      updateSessionClaudeId(session.id, result.claudeSessionId);
    }

    return result;
  }
```

- [ ] **Step 2: Update stop() to keep tmux session alive**

```typescript
  async stop(threadId: string, reason: StopReason = "manual"): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`スレッド ${threadId} にセッションが見つかりません`);
    }

    session.status = "stopping";
    console.log(`[SessionManager] Stopping session in thread ${threadId} (reason: ${reason})`);

    // Don't kill tmux — keep it alive for --resume debugging
    // Just remove from active sessions map
    this.sessions.delete(threadId);
    markTabStopped(session.channelName);
    updateSessionStatus(session.id, "stopped", reason);
  }
```

- [ ] **Step 3: Run tests**

Run: `SUPERVISOR_DB_PATH=":memory:" bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add supervisor/src/session/manager.ts
git commit -m "feat(session): pass session info to relay, keep tmux on stop"
```

---

### Task 4: ウェルカムメッセージに tmux session name を表示

**Files:**
- Modify: `supervisor/src/commands/session.ts`

- [ ] **Step 1: Update handleStart to show tmux info**

In the thread welcome message, add tmux session name:

```typescript
    await thread.send(
      `✅ **${config.displayName}** のセッションを開始しました\n\n` +
        `📁 ディレクトリ: \`${config.dir}\`\n` +
        `📊 稼働中セッション: ${sessionManager.count()}/${MAX_SESSIONS}\n` +
        `🔑 tmux: \`${session.tmuxSessionName}\`\n\n` +
        `このスレッドにメッセージを送信すると、Claude Code に中継されます。\n` +
        `終了するには \`/session stop\` をこのスレッド内で実行してください。\n` +
        `調査用: \`tmux attach -t ${session.tmuxSessionName}\``
    );
```

- [ ] **Step 2: Expose tmuxSessionName from SessionInfo or manager**

Add to `SessionInfo` in `types.ts`:

```typescript
export interface SessionInfo {
  // ... existing fields
  tmuxSessionName: string; // Added for Discord display
}
```

Set it in `manager.start()`:

```typescript
const info: SessionInfo = {
  // ... existing fields
  tmuxSessionName: tmuxName,
};
```

- [ ] **Step 3: Run tests and typecheck**

Run: `SUPERVISOR_DB_PATH=":memory:" bun test && bunx tsc --noEmit`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add supervisor/src/commands/session.ts supervisor/src/session/types.ts supervisor/src/session/manager.ts
git commit -m "feat(session): show tmux session name in welcome message"
```

---

### Task 5: E2E テストと CI 確認

**Files:**
- No new files

- [ ] **Step 1: Run full test suite**

Run: `SUPERVISOR_DB_PATH=":memory:" bun test && bunx tsc --noEmit`
Expected: All pass

- [ ] **Step 2: Start Supervisor and test in Discord**

```bash
pkill -f "bun run index.ts" 2>/dev/null; sleep 2
cd supervisor && bun run index.ts > /tmp/supervisor-fallback.log 2>&1 &
```

Test sequence:
1. `/session start` in #oci-develop → verify tmux name in welcome message
2. Send `pwd` → verify response appears in thread
3. Send a complex query → verify Phase 1 or Phase 2 response

- [ ] **Step 3: Check logs for Phase 1/Phase 2 usage**

```bash
grep "\[Relay\]" /tmp/supervisor-fallback.log
```

Expected: `Phase 1 succeeded` or `Phase 1 failed, falling back to claude -p`

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix: E2E test fixes for relay fallback"
```

- [ ] **Step 5: Push and verify CI**

```bash
git push
gh run list --limit 1
```
