# Supervisor アーキテクチャ（確定版）

最終更新: 2026-04-19 (Epic #45 S1-S9 完了後、Issue #56 で確定)

## 概要

Discord 経由で複数の Claude Code セッションを並列運用するための Supervisor Bot。
1 Supervisor + N 専用 Bot 構成で、1 チャンネル N セッション（スレッド分離）と動的起動を実現する。

## 採用アーキテクチャ: Supervisor + tmux + Hook HTTP Relay

Issue #13 で評価した 20 通り（A-T）のうち、以下の **A + B + G** の漸進フォールバック組合せを採用。T 案（カスタム Channel プラグイン）は要件消滅のため Kill（Issue #14 Close）。

| 要件 | 充足方式 | 該当 hook / コード |
|---|---|---|
| 1 Bot Token で 1 チャンネル N セッション | Discord スレッド分離 + `threadId → SessionInfo` マップ | `src/session/manager.ts` |
| 動的セッション起動 | Slash Command `/session start` → tmux 新規起動 | `src/commands/session.ts` |
| Discord → Claude Code 入力 | `tmux send-keys` で stdin 注入 | `src/session/relay.ts` |
| Claude Code → Discord 応答 | **Stop hook → HTTP POST → Supervisor relay-server** | `hooks/stop-relay.sh` + `src/session/relay-server.ts` |
| 中間進捗表示 | **PostToolUse hook → HTTP POST → Supervisor `/progress`** | `hooks/progress-relay.sh` |
| パーミッションデッドロック回避 | **PermissionRequest hook で自動承認** + Supervisor セッションは `--dangerously-skip-permissions` を常時付与（`manager.ts:130`） | `hooks/auto-approve-permission.sh` + `src/session/manager.ts` |
| 画像添付 (Discord → Claude) | Discord 画像を `~/claude-hub/tmp/attachments` に DL → メッセージ本文先頭に `Read the image at <path>` を連結して `tmux send-keys` で注入 | `src/session/relay.ts` (`downloadAttachment` + `relayMessage`) |
| ファイル添付 (Claude → Discord) | Claude の応答からファイルパスを抽出し Discord にアップロード | `src/session/file-attacher.ts` |

## メッセージフロー

```
/session start (Discord Slash)
  ├─ Supervisor: Bun.serve() で HTTP relay 起動 (localhost:PORT)
  ├─ Discord スレッド作成
  ├─ DB に threadId + tmuxSessionName 登録
  └─ tmux new-session で Claude Code 起動
       env: SUPERVISOR_RELAY_URL=http://localhost:PORT/relay/{threadId}
       args: --dangerously-skip-permissions --name <channelName>
       hook: Stop / PostToolUse / PermissionRequest

スレッド内メッセージ受信
  ↓
Supervisor: threadId → tmuxSession 解決
  ↓
tmux send-keys (stdin)
  ↓
Claude Code 処理
  ├─ ツール実行ごと → PostToolUse hook → POST /progress/{threadId}
  │                                        ↓
  │                                    Discord スレッドに "🔧 Read 実行完了" 等を逐次投稿
  │
  └─ ターン完了 → Stop hook → POST /relay/{threadId}
                                 ↓
                             Supervisor: pending Promise resolve
                                 ↓
                             Discord スレッドに最終応答投稿
```

## 関連設計書（経緯）

| 設計書 | 対応実装 |
|---|---|
| `docs/superpowers/specs/2026-03-30-thread-session-isolation-design.md` | スレッド分離・`--channels` 廃止・`claude -p --resume` 方式 |
| `docs/superpowers/specs/2026-03-30-hook-http-relay-design.md` | Stop hook + HTTP Relay（capture-pane スクレイピング廃止） |
| `docs/superpowers/specs/2026-03-30-relay-fallback-design.md` | リレー失敗時のフォールバック |
| `docs/superpowers/specs/2026-03-29-iterm2-tab-visualization-design.md` | iTerm2 タブ可視化（optional） |

## Epic #13 との関係（PoC 判定）

Issue #13 で評価した Phase 1 PoC の最終判定:

| PoC | 判定 | 理由 |
|---|---|---|
| #15 AskUserQuestion 双方向中継 | **Kill（学習完了）** | `--channels` モードでは動作するが、1 Bot Token = 1 セッション制約のため、マルチセッション要件と両立不可。ここで得た「DM に Allow/Deny ボタンが出せる」知見は T 案の設計材料として保存 |
| #16 中間進捗表示 | **Keep（実装完了）** | PoC 仮説どおり `--channels` 標準機能だけでは不可 → **PostToolUse hook 方式**で解決。`supervisor/hooks/progress-relay.sh` として本番稼働 |
| #14 カスタム Channel プラグイン（T 案） | **Kill（要件消滅）** | 1ch 複数セッション / 動的起動 / ダイアログ解決 / 中間進捗 の 4 要件を現方式で全充足したため、T 案の目的が消滅。Research Preview 依存のリスクもあり、着手しない |

## 退役した方式（参考）

- **`--channels plugin:discord`**: Phase 1 PoC（#15 成功）で双方向通信を確認したが、1 Token = 1 セッション制約により Phase 2 で廃止。現コードからは runtime 依存なし（`claudeHubExit` Bot のコメントに名残のみ）
- **`tmux capture-pane` ポーリング**: CRITICAL 欠陥 3 件（セッション競合・重複・TUI スクレイピング不安定）で却下。Stop hook 方式に置換

## セキュリティ境界（S3/S7/S8/S9 で確定）

- Supervisor 配下の Claude Code セッション (`manager.ts:130`) は `--dangerously-skip-permissions` を常時付与。PermissionRequest hook (`hooks/auto-approve-permission.sh`) がデッドロック防止を担う
- `scripts/start-hijoguchi.sh` (`claudeHubExit` bot) のみ `CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS` 環境変数で `--dangerously-skip-permissions` を条件分岐。Phase 1 は default=1（現状）、Phase 2 で default=0 に切替予定 (#53)。`.claude/settings.json` の `permissions.allow`/`deny` が運用ポリシーの single source
- `protect-config.sh` で Write/Edit の機密パス（`.env`, `access.json` 等）をブロック (#54)
- `prompt-title-check.py` に構造化 JSON ログ出力 (#55)
- `access.json allowFrom` でチャンネル単位のアクセス制御 (#47)
- `hijoguchi-system-prompt.md` + システムプロンプト固定で `claudeHubExit` bot の応答スコープを制限 (#49)
