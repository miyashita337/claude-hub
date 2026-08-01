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

# 常駐 (launchd)。plist 内の /Users/YOUR_USER プレースホルダを $HOME に置換して配置する
# source は絶対パスで指定する: 相対パスだと cwd 違いで sed が失敗しても > が
# installed plist を空ファイルに切り詰めてしまう
mkdir -p ~/claude-hub/logs
sed "s|/Users/YOUR_USER|$HOME|g" ~/claude-hub/com.claude-hub.supervisor.plist > ~/Library/LaunchAgents/com.claude-hub.supervisor.plist
launchctl load ~/Library/LaunchAgents/com.claude-hub.supervisor.plist
# 再設置時の注意: 上の sed は installed plist を上書きするため、手動記入した
# HIJOGUCHI_CHANNEL_ID (channel id は非コミット。Issue #63) が消える。再記入 +
# bootout/bootstrap で再ロードすること。詳細は docs/bot-operations.md を参照

# 添付ファイルの日次GC (launchd, 04:00 に tmp/attachments の30日超を削除。Issue #151/#280)
bash scripts/install-gc-attachments.sh
```

launchd plist は全て `/Users/YOUR_USER` プレースホルダで管理し、install 時に `$HOME` へ置換する
（Issue #198）。ハードコードされたユーザーパスの再混入は CI で機械検知する:
`bash scripts/test-plist-placeholders.sh`

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

```text
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

## 添付ファイルの GC (Issue #151)

Discord で受領した素材は `~/claude-hub/tmp/attachments` に保存され、**30 日保持**される
（以前は relay 完了の 5 分後に削除され、セッションを跨ぐと素材が消えていた）。
日次 GC ジョブで 30 日超のファイルのみ削除し、削除ごとに warning ログを残す。

```bash
# 手動実行 (動作確認・即時 GC)
bun run supervisor/src/session/gc-attachments.ts

# 日次自動 GC を常駐化 (04:00 実行)。logs/ が無ければ先に作成する
mkdir -p ~/claude-hub/logs
# plist 内の /Users/YOUR_USER プレースホルダを $HOME に置換して配置する
sed "s|/Users/YOUR_USER|$HOME|g" com.claude-hub.gc-attachments.plist > ~/Library/LaunchAgents/com.claude-hub.gc-attachments.plist
launchctl load ~/Library/LaunchAgents/com.claude-hub.gc-attachments.plist

# GC ログ確認 (削除実績の consumer)
tail ~/claude-hub/logs/gc-attachments.stdout.log
```
