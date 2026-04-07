# Discord Bot 運用方針

claude-hub プロジェクトで運用している Discord Bot の役割分担と運用ルール。

## Bot 一覧

### 1. Channel-Supervisor
- **コード**: `~/claude-hub/supervisor/`
- **プロセス**: `com.claude-hub.supervisor` (launchd, caffeinate wrapper)
- **対象プロジェクト**: 外部プロジェクト（claude-hub 自体は**含めない**）
  - 現在: team-salary, convert-service, segment-anything, claude-context-manager, dev-tool, obsidian-img-annotator, oci-develop
  - 追加は `supervisor/src/config/channels.ts` の `CHANNEL_MAP` を編集
- **方式**: tmux + Claude Code CLI + HTTP relay (Stop/PostToolUse hook)
- **コマンド**: `/session start|stop|list`
- **メッセージ中継**: Discord thread ↔ tmux send-keys ↔ Claude Code

### 2. claudeHubExit（旧 PM-Agent）
- **対象**: `~/claude-hub` 自体のメンテナンス専用
- **方式**: Claude Code `--channels plugin:discord@claude-plugins-official` 直結
- **起動**: `tmux -CC new-session ... --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions`
- **役割**: **Channel-Supervisor 自身が壊れた時の非常口**

## 絶対ルール

> **Channel-Supervisor の `CHANNEL_MAP` に `claude-hub` を追加してはいけない**

理由: メタ依存（Supervisor のバグ修正を同じ Supervisor 経由で行う構造）になると、Supervisor がクラッシュした瞬間に Discord 経由での復旧経路が失われる。必ず claudeHubExit という独立した経路を残す。

## 運用シナリオ

### 通常作業（外部プロジェクト）
1. Discord サーバの対象チャンネル（例 `#dev-tool`）で `/session start`
2. 作成されたスレッドにメッセージを送信 → Channel-Supervisor が Claude Code に中継
3. 終了時は `/session stop`

### claude-hub 自体の修正
1. Discord DM の `claudeHubExit` Bot を使用
2. `--channels plugin:discord` 直結モードで Claude Code が動作
3. Channel-Supervisor の状態に依存せず作業可能

### Channel-Supervisor 復旧
1. `supervisor.stderr.log` を確認
2. 必要なら `claudeHubExit` 経由で修正
3. ローカルで `launchctl kickstart -k gui/$(id -u)/com.claude-hub.supervisor`

## 関連ファイル

- `supervisor/src/config/channels.ts` — CHANNEL_MAP 定義 + claude-hub ガード
- `supervisor/com.channel.supervisor.plist` — launchd plist (caffeinate wrapper 付き)
- `~/Library/LaunchAgents/com.claude-hub.supervisor.plist` — 実際にロードされている plist
- `~/claude-hub/logs/supervisor.{stdout,stderr}.log` — supervisor ログ

## 参考: 過去の事故

- Issue #21: Mac スリープ/復帰で Discord interaction token が失効 → unhandled rejection → Bun プロセスクラッシュ。PR #22 で `unhandledRejection`/`uncaughtException` handler + safe reply wrapper を追加して修正
