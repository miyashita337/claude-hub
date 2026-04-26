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
- **起動**: `tmux -CC new-session ... --channels plugin:discord@claude-plugins-official`
  - `CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=1` （Phase 1 default）の場合のみ `--dangerously-skip-permissions` を追加。詳細は本 doc 下部の「Permission Mode (claudeHubExit)」参照
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

## Access Policy (claudeHubExit)

claudeHubExit Bot は `~/.claude/channels/discord/access.json` で access 制御される。Issue #47 以降、以下の方針で運用する。

### Primary / Non-primary

| 種類 | channel | `requireMention` | `allowFrom` |
|---|---|---|---|
| Primary | `#claude-hub-hijoguchi` (`1487701062205964329`) | `false` | `[]`（全員通す。通常運用チャンネルのため） |
| Non-primary | team-salary ほか計 7 つの外部プロジェクト用 group | `true` | `["596802737950294036"]`（owner のみ） |

### 意図

- **Primary**: claude-hub の保守チャンネル。常時やり取りが発生するため mention 不要で allowFrom も空
- **Non-primary**: 他プロジェクト thread。基本 Channel-Supervisor が担当するため claudeHubExit は普段応答しないが、Supervisor 障害時に owner が mention して問い合わせる経路として残す。非 owner からの mention は silent drop される

### 反映

access.json は毎メッセージ読み込まれるため、編集は即反映。Bot 再起動不要。

### 変更手順

1. `cp access.json access.json.bak.YYYYMMDD`（日付付きバックアップ）
2. `jq` で atomic write（`tmp` ファイル → `mv`）
3. `jq empty access.json` で schema 検証
4. 動作確認: 実メッセージで owner mention → 応答あり / 非 owner mention → 無応答

## Permission Mode (claudeHubExit)

Issue #53 以降、`--dangerously-skip-permissions` を env var で条件分岐している。`.claude/settings.json` が auto-load され、`permissions.allow`/`permissions.deny` が運用ポリシーの単一 source になる。

### `CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS`

| 値 | モード | 挙動 |
|---|---|---|
| `1`（現在の default） | unsafe_skip | `--dangerously-skip-permissions` を渡す。allow/deny は noop |
| `0` または他の値 | enforce | フラグを外し、`.claude/settings.json` の allow/deny で権限制御 |

**ログ**: 起動時に `[hijoguchi] permission_mode=...` が `logs/hijoguchi.stderr.log` に出るので、どちらで走っているか grep で確認可能。

### Phase 2 移行チェックリスト

`CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS` の default を `0` に flip する際は以下を**必ず**実施:

1. `.claude/settings.json` の allow 列に現行運用で必要なツールが揃っているか見直す（特に新規追加された保守スクリプト）
2. `~/Library/LaunchAgents/com.claude-hub.hijoguchi.plist` の `EnvironmentVariables` に `CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=1` が **残留していないか確認・削除**（残っていると script の default flip が無効化される silent degrade）
3. staging 相当の local で `CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=0 bash scripts/start-hijoguchi.sh` を短時間回し、Discord 実機で 通常 Q&A（`@claudeHubExit git status` 等）が応答することを確認
4. 権限拒否ログが `logs/hijoguchi.stderr.log` に出ることを `@claudeHubExit curl example.com` 等で試して確認

## Required env vars (claudeHubExit)

Issue #63 で `start-hijoguchi.sh` を **fail-closed** 化した。production の `HIJOGUCHI_CHANNEL_ID` / `HIJOGUCHI_BOT_MENTION` の default を script から削除し、両 env var が unset または空文字なら exit 1 で abort する（silent に legacy production channel へ routing する事故防止）。

### plist `EnvironmentVariables` 設定

`~/Library/LaunchAgents/com.claude-hub.hijoguchi.plist` (`.gitignore` 管理 / local 配布) に以下を追加:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>HIJOGUCHI_CHANNEL_ID</key>
  <string>1487701062205964329</string>
  <key>HIJOGUCHI_BOT_MENTION</key>
  <string>&lt;@1487717424173416538&gt;</string>
  <!-- 既存の他 env (CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS 等) はそのまま残す -->
</dict>
```

`<` `>` は XML escape で `&lt;` `&gt;` を使う（`<@...>` の Discord mention 形式そのままだと plist がパース失敗）。

### 反映手順

```bash
# 1. plist バックアップ
cp ~/Library/LaunchAgents/com.claude-hub.hijoguchi.plist{,.bak.$(date +%Y%m%d)}

# 2. plist を新 env 付きに置換 (上記 EnvironmentVariables を追記)

# 3. launchd reload (本番 Bot ダウンタイム数秒～)
launchctl unload ~/Library/LaunchAgents/com.claude-hub.hijoguchi.plist
launchctl load   ~/Library/LaunchAgents/com.claude-hub.hijoguchi.plist

# 4. 起動確認
launchctl list | grep claude-hub.hijoguchi   # PID が変わっていること
tmux list-sessions | grep claudeHubExit       # tmux session 再生成
tail -f logs/hijoguchi.stderr.log             # `[hijoguchi] permission_mode=...` が出る
```

### 障害復旧（env 注入忘れ）

plist に env 漏れがあると `[hijoguchi] ERROR: HIJOGUCHI_CHANNEL_ID is required ...` で exit 1。launchd KeepAlive は再試行するが起動失敗のままになる（=fail-closed の意図通り）。`logs/hijoguchi.stderr.log` を grep して plist を修正 → reload。

### Phase 2 移行チェックリスト前提

下記 Phase 2 移行は本 env 注入が完了している前提。両 env が plist にあることを `defaults read ~/Library/LaunchAgents/com.claude-hub.hijoguchi.plist EnvironmentVariables` などで確認してから進めること。

## 参考: 過去の事故

- Issue #21: Mac スリープ/復帰で Discord interaction token が失効 → unhandled rejection → Bun プロセスクラッシュ。PR #22 で `unhandledRejection`/`uncaughtException` handler + safe reply wrapper を追加して修正
- Issue #47: 非 primary group の `allowFrom` が空 → 非 owner の mention でも Bot が応答する状態を修正。owner ID を明示列挙
