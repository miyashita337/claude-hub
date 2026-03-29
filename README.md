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
