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

## 添付ファイルの GC (Issue #151)

Discord で受領した素材は `~/claude-hub/tmp/attachments` に保存され、**30 日保持**される
（以前は relay 完了の 5 分後に削除され、セッションを跨ぐと素材が消えていた）。
日次 GC ジョブで 30 日超のファイルのみ削除し、削除ごとに warning ログを残す。

```bash
# 手動実行 (動作確認・即時 GC)
bun run supervisor/src/session/gc-attachments.ts

# 日次自動 GC を常駐化 (04:00 実行)。logs/ が無ければ先に作成する
mkdir -p ~/claude-hub/logs
cp com.claude-hub.gc-attachments.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claude-hub.gc-attachments.plist

# GC ログ確認 (削除実績の consumer)
tail ~/claude-hub/logs/gc-attachments.stdout.log
```
