# iTerm2タブ可視化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supervisorがセッション起動時にiTerm2タブを自動追加し、tmux attachでリアルタイム確認できるようにする

**Architecture:** tmuxをプロセス管理のバックボーンとして維持し、iTerm2タブはビューアとして機能。osascript（AppleScript）でiTerm2を操作。失敗時はtmuxのみで動作（フォールバック）。

**Tech Stack:** TypeScript (Bun), AppleScript (osascript), tmux, iTerm2

**Spec:** `docs/superpowers/specs/2026-03-29-iterm2-tab-visualization-design.md`

---

## File Structure

| ファイル | 責務 | 変更 |
|---|---|---|
| `supervisor/src/session/iterm2.ts` | iTerm2タブ操作（開く・停止マーク・色解決） | 新規 |
| `supervisor/src/session/manager.ts` | セッション管理にiTerm2タブ連携を追加 | 修正 |
| `supervisor/tests/session/iterm2.test.ts` | iterm2モジュールのユニットテスト | 新規 |
| `supervisor/tests/session/manager-iterm2.test.ts` | manager の iTerm2連携部分のテスト | 新規 |

---

### Task 1: iTerm2モジュール — resolveColor のテストと実装

**Files:**
- Create: `supervisor/src/session/iterm2.ts`
- Create: `supervisor/tests/session/iterm2.test.ts`
- Read: `~/.claude/scripts/project-colors.json`

- [ ] **Step 1: Write the failing test for resolveColor**

```typescript
// supervisor/tests/session/iterm2.test.ts
import { test, expect, describe } from "bun:test";
import { resolveColor } from "../../src/session/iterm2";

describe("resolveColor", () => {
  test("returns exact match from project-colors.json", () => {
    // project-colors.json has "team_salary": "#1e1028"
    const color = resolveColor("team_salary");
    expect(color).toBe("#1e1028");
  });

  test("returns prefix match (longest wins)", () => {
    // "team_salary" matches, but "team_salary_blog" is longer prefix for "team_salary_blog"
    const color = resolveColor("team_salary_blog");
    expect(color).toBe("#102525");
  });

  test("returns hash-based color for unknown project", () => {
    const color = resolveColor("unknown-project-xyz");
    // Should be a valid hex color
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("hash-based color is deterministic", () => {
    const color1 = resolveColor("some-project");
    const color2 = resolveColor("some-project");
    expect(color1).toBe(color2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd supervisor && bun test tests/session/iterm2.test.ts`
Expected: FAIL — `resolveColor` not found

- [ ] **Step 3: Implement resolveColor**

```typescript
// supervisor/src/session/iterm2.ts
import { execSync } from "child_process";
import { resolve } from "path";
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
    const file = Bun.file(PROJECT_COLORS_PATH);
    // Bun.file().json() is async, use readFileSync for simplicity in sync context
    const text = require("fs").readFileSync(PROJECT_COLORS_PATH, "utf8");
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

  // Longest prefix match
  let bestMatch = "";
  let bestColor = "";
  for (const [key, color] of Object.entries(projects)) {
    if (projectName.startsWith(key) && key.length > bestMatch.length) {
      bestMatch = key;
      bestColor = color;
    }
  }
  if (bestColor) return bestColor;

  // Hash-based fallback (same algorithm as session_title_utils.py)
  const saturation = config.default_saturation ?? 0.3;
  const brightness = config.default_brightness ?? 0.12;
  const hash = createHash("sha256").update(projectName).digest("hex");
  const hue = (parseInt(hash.slice(0, 8), 16) % 360) / 360;
  const [r, g, b] = hlsToRgb(hue, brightness, saturation);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd supervisor && bun test tests/session/iterm2.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add supervisor/src/session/iterm2.ts supervisor/tests/session/iterm2.test.ts
git commit -m "feat(iterm2): add resolveColor with project-colors.json support"
```

---

### Task 2: iTerm2モジュール — isItermRunning, dimColor

**Files:**
- Modify: `supervisor/src/session/iterm2.ts`
- Modify: `supervisor/tests/session/iterm2.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to supervisor/tests/session/iterm2.test.ts
import { resolveColor, dimColor, isItermRunning } from "../../src/session/iterm2";

describe("dimColor", () => {
  test("reduces brightness by 50%", () => {
    // #1e1028 → should be darker
    const dimmed = dimColor("#1e1028");
    expect(dimmed).toMatch(/^#[0-9a-f]{6}$/);
    // R, G, B should all be <= original
    const origR = parseInt("1e", 16); // 30
    const dimR = parseInt(dimmed.slice(1, 3), 16);
    expect(dimR).toBeLessThanOrEqual(origR);
  });

  test("handles pure black", () => {
    const dimmed = dimColor("#000000");
    expect(dimmed).toBe("#000000");
  });

  test("handles bright color", () => {
    const dimmed = dimColor("#ff8844");
    expect(dimmed).toMatch(/^#[0-9a-f]{6}$/);
    const origR = parseInt("ff", 16);
    const dimR = parseInt(dimmed.slice(1, 3), 16);
    expect(dimR).toBeLessThan(origR);
  });
});

describe("isItermRunning", () => {
  test("returns a boolean", () => {
    const result = isItermRunning();
    expect(typeof result).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd supervisor && bun test tests/session/iterm2.test.ts`
Expected: FAIL — `dimColor` and `isItermRunning` not found

- [ ] **Step 3: Implement isItermRunning and dimColor**

Add to `supervisor/src/session/iterm2.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd supervisor && bun test tests/session/iterm2.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add supervisor/src/session/iterm2.ts supervisor/tests/session/iterm2.test.ts
git commit -m "feat(iterm2): add isItermRunning and dimColor"
```

---

### Task 3: iTerm2モジュール — openTab, markTabStopped

**Files:**
- Modify: `supervisor/src/session/iterm2.ts`

- [ ] **Step 1: Implement openTab**

Add to `supervisor/src/session/iterm2.ts`:

```typescript
export interface OpenTabOptions {
  tmuxSessionName: string;
  channelName: string;
  projectDir: string;
}

export function openTab(opts: OpenTabOptions): void {
  if (!isItermRunning()) {
    console.log(`[iTerm2] iTerm2 is not running, skipping tab creation for ${opts.channelName}`);
    return;
  }

  const color = resolveColor(
    require("path").basename(opts.projectDir)
  );
  const hex = color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) * 257;
  const g = parseInt(hex.slice(2, 4), 16) * 257;
  const b = parseInt(hex.slice(4, 6), 16) * 257;

  const script = `
tell application "iTerm2"
  tell current window
    create tab with default profile
    tell current session
      write text "tmux attach -t ${opts.tmuxSessionName}"
      set name to "${opts.channelName} (running)"
      set background color to {${r}, ${g}, ${b}}
    end tell
  end tell
end tell`;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 5000,
    });
    console.log(`[iTerm2] Opened tab for ${opts.channelName}`);
  } catch (err) {
    console.error(`[iTerm2] Failed to open tab for ${opts.channelName}:`, err);
  }
}
```

- [ ] **Step 2: Implement markTabStopped**

Add to `supervisor/src/session/iterm2.ts`:

```typescript
export function markTabStopped(channelName: string): void {
  if (!isItermRunning()) {
    return;
  }

  const tabName = `${channelName} (running)`;
  const newName = `${channelName} (stopped)`;

  const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      try
        if name of current session of t is "${tabName}" then
          tell current session of t
            set name to "${newName}"
          end tell
        end if
      end try
    end repeat
  end repeat
end tell`;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 5000,
    });
    console.log(`[iTerm2] Marked tab stopped for ${channelName}`);
  } catch (err) {
    console.error(`[iTerm2] Failed to mark tab stopped for ${channelName}:`, err);
  }
}
```

- [ ] **Step 3: Verify module exports compile**

Run: `cd supervisor && bun build src/session/iterm2.ts --no-bundle 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add supervisor/src/session/iterm2.ts
git commit -m "feat(iterm2): add openTab and markTabStopped"
```

---

### Task 4: SessionManager に iTerm2 連携を組み込む

**Files:**
- Modify: `supervisor/src/session/manager.ts:1-10` (imports)
- Modify: `supervisor/src/session/manager.ts:80-178` (start method)
- Modify: `supervisor/src/session/manager.ts:181-273` (resume method)
- Modify: `supervisor/src/session/manager.ts:275-312` (stop method)
- Modify: `supervisor/src/session/manager.ts:333-347` (watchTmuxSession)

- [ ] **Step 1: Add import**

Add to the imports section of `supervisor/src/session/manager.ts`:

```typescript
import { openTab, markTabStopped } from "./iterm2";
```

- [ ] **Step 2: Add openTab to start() method**

After the `console.log` at the end of `start()` (line 176), before `return info;`, add:

```typescript
    // Open iTerm2 tab as viewer (non-blocking, failure is safe)
    openTab({
      tmuxSessionName: tmuxName,
      channelName: config.channelName,
      projectDir: config.dir,
    });
```

- [ ] **Step 3: Add openTab to resume() method**

After the `console.log` at the end of `resume()` (line 270), before `return info;`, add:

```typescript
    // Open iTerm2 tab as viewer (non-blocking, failure is safe)
    openTab({
      tmuxSessionName: tmuxName,
      channelName: config.channelName,
      projectDir: config.dir,
    });
```

- [ ] **Step 4: Add markTabStopped to stop() method**

After `this.sessions.delete(channelName);` (line 310), before `updateSessionStatus`, add:

```typescript
    markTabStopped(channelName);
```

- [ ] **Step 5: Add markTabStopped to watchTmuxSession()**

Inside the `if (!this.isTmuxSessionAlive(tmuxName))` block in `watchTmuxSession()`, after `this.sessions.delete(channelName);` (line 343), add:

```typescript
        markTabStopped(channelName);
```

- [ ] **Step 6: Verify build**

Run: `cd supervisor && bun build src/bot.ts --no-bundle 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add supervisor/src/session/manager.ts
git commit -m "feat(session): integrate iTerm2 tab lifecycle into SessionManager"
```

---

### Task 5: 手動テスト・動作確認

**Files:**
- Read: `supervisor/src/session/iterm2.ts`

- [ ] **Step 1: resolveColor の Python 実装との一致確認**

```bash
cd supervisor && bun -e "
const { resolveColor } = require('./src/session/iterm2');
const projects = ['team_salary', 'team_salary_blog', 'convert-service', 'claude-hub', 'unknown-project'];
for (const p of projects) {
  console.log(p + ' → ' + resolveColor(p));
}
"
```

Expected: `team_salary` → `#1e1028`, `team_salary_blog` → `#102525`, `convert-service` → `#0d2818`

- [ ] **Step 2: isItermRunning の確認**

```bash
cd supervisor && bun -e "
const { isItermRunning } = require('./src/session/iterm2');
console.log('iTerm2 running:', isItermRunning());
"
```

Expected: `true`（iTerm2が開いている場合）

- [ ] **Step 3: openTab の手動テスト**

```bash
# まず dummy の tmux セッションを作る
tmux new-session -d -s "claude-test-manual"

# openTab を呼ぶ
cd supervisor && bun -e "
const { openTab } = require('./src/session/iterm2');
openTab({
  tmuxSessionName: 'claude-test-manual',
  channelName: 'test-manual',
  projectDir: '$HOME/claude-hub',
});
"
```

Expected: iTerm2に新しいタブが追加され、tmuxセッションにattachされる。タブ名が `test-manual (running)`、背景色がclaude-hubのプロジェクト色になる。

- [ ] **Step 4: markTabStopped の手動テスト**

```bash
cd supervisor && bun -e "
const { markTabStopped } = require('./src/session/iterm2');
markTabStopped('test-manual');
"
```

Expected: タブ名が `test-manual (stopped)` に変わる。

- [ ] **Step 5: クリーンアップ**

```bash
tmux kill-session -t "claude-test-manual" 2>/dev/null
```

- [ ] **Step 6: 全テスト実行**

Run: `cd supervisor && bun test`
Expected: All tests PASS

- [ ] **Step 7: Commit (テストに修正があれば)**

```bash
git add -A supervisor/tests/ supervisor/src/
git commit -m "test(iterm2): verify resolveColor parity and manual integration"
```

---

## Self-Review Checklist

- [x] Spec coverage: resolveColor, isItermRunning, openTab, markTabStopped, フォールバック、タブライフサイクル — 全て実装タスクあり
- [x] Placeholder scan: TBD/TODO なし、全ステップにコード記載
- [x] Type consistency: `OpenTabOptions` の型、`resolveColor`/`dimColor`/`isItermRunning`/`openTab`/`markTabStopped` の関数名が全タスクで一致
- [x] dimColor は Task 2 で実装するが、openTab 内では直接使わない（markTabStopped での背景色変更は将来拡張）→ spec の「50%輝度」要件は dimColor で対応可能な状態にしておくが、markTabStopped の AppleScript でタブ背景色変更は複雑になるため、まずタイトル変更のみで MVP とする
