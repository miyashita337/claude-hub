# claude-hub

Discord経由でClaude Codeセッションを管理するSupervisor Bot。

## アーキテクチャ

- **Supervisor Bot** (Bun + discord.js): Slash Commandでセッション管理
- **プロジェクト専用Bot**: 各チャンネルのClaude Code用Discord Gateway接続
- **launchd**: Supervisor Botの常駐化
- **tmux**: Claude Codeセッション起動（TTY必須）

## ディレクトリ構成

```
claude-hub/
  supervisor/     # Supervisor Bot (Bun + TypeScript)
  screenshot-saver/ # スクリーンショット保存ユーティリティ
  docs/           # アーキテクチャ図等
```

## セットアップ

```bash
cd supervisor
bun install
cp .env.example .env  # トークン設定
```

## 起動

```bash
# 開発
bun run supervisor/index.ts

# 常駐 (launchd)
launchctl load ~/Library/LaunchAgents/com.claude-hub.supervisor.plist
```

## ローカル E2E 検証

手元の Mac で **実 Chrome（Claude in Chrome 拡張）+ 実 Discord ログイン状態** を使い、
`/session start` → Welcome → ping 応答 → `/session stop` → アーカイブ を一気通貫で検証するスキル。

CI 版（Issue #111、headless / API direct）が拾えない局面を補完する:

- PR を投げる前のローカル pre-flight 確認
- CI fail のローカル再現デバッグ
- supervisor 設計変更時の実 UI 目視（装飾・絵文字レンダリング）
- macOS 固有の flake 調査

### 使い方

Claude Code で以下を実行する:

```
/local-e2e-discord
/local-e2e-discord --channel openclaw-rpi5-ops --branch local-e2e-test
/local-e2e-discord --expect-fail   # supervisor 停止状態で FAIL を期待する失敗ケース検証
```

### 前提

| 前提 | 不足時 |
|---|---|
| Chrome に Claude in Chrome 拡張がインストール済み | スキルが手順 0 で停止し導入を案内 |
| Discord に **ログイン済み**のタブが Chrome にある | 「Discord にログインしてください」と出力して停止 |
| Supervisor Bot が稼働中 | `--expect-fail` 以外では稼働が必要 |

### 注意

- `/session start <branch>` は **branch 引数必須**（Issue #175）。`--branch` には使い捨て名（既定 `local-e2e-test`）を使い、既存の作業 branch を指定しないこと（worktree 共有事故回避）。
- 失敗時 / `--keep-thread` 時はテスト thread と `local-e2e-test` の worktree が残るため手動 cleanup する。
- 1 Chrome ウィンドウ 1 セッション。並列実行は想定しない。

詳細・全オプションはスキル定義 [`.claude/commands/local-e2e-discord.md`](./.claude/commands/local-e2e-discord.md) を参照。
