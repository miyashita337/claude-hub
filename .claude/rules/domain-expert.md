# ドメインエキスパート: Discord × Claude Code セッション管理

## プロジェクト概要
Discord Bot経由でClaude Codeセッションを管理するSupervisorシステム。iPhoneからDiscord経由で複数プロジェクトのClaude Codeを操作するためのインフラ。

## ドメイン知識
- Discord Bot (discord.js): Gateway接続、Slash Command、チャンネル権限管理
- Claude Code `--channels`: Discord/Slack等のチャンネル経由でのCLI操作
- プロセス管理: tmux/launchd によるセッションライフサイクル
- マルチテナント: 1 Supervisor + N 専用Bot のアーキテクチャ

## 技術スタック
- **Runtime**: Bun
- **言語**: TypeScript
- **Discord**: discord.js v14
- **DB**: SQLite (bun:sqlite)
- **プロセス管理**: tmux, launchd
- **常駐化**: macOS LaunchAgents

## レビュー時の重点チェック項目
- Discord Gateway の1トークン1接続制約を守っているか
- Claude Code セッションがTTYを確保しているか (tmux必須)
- 環境変数 (DISCORD_BOT_TOKEN, DISCORD_STATE_DIR) のセッション間分離
- SQLite の同時アクセスとWALモード設定
- launchd plist のパス整合性
