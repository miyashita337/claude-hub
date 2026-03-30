# Issue #4: tmux 常駐 + claude -p フォールバック方式 — 設計書

## 概要

capture-pane スクレイピングの CRITICAL な欠陥（バッファ溢れ、タイミング誤検知、SessionStart フック混入）を解決するため、tmux 常駐方式を維持しつつ、応答抽出に失敗した場合に `claude -p --resume` で確実にリカバリするフォールバック方式を導入する。

## 背景

- capture-pane は TUI をスクレイピングしており、本質的に脆い
- 全面的に `claude -p` に切り替えるとコンテキスト維持と長時間タスクが失われる
- iTerm2 タブは optional だが、tmux session ID でのデバッグ手段は必要

## アーキテクチャ

### 通信フロー

```
/session start
  ├── tmux セッション起動（Claude Code 常駐）
  ├── Discord スレッド作成（tmux session name 表示）
  └── iTerm2 タブ（optional、失敗しても続行）

メッセージ受信（Discord スレッド内）
  ↓
Phase 1: tmux 経由（プライマリ、最大30秒）
  ├── tmux send-keys でメッセージ送信
  ├── capture-pane ポーリング
  ├── extractResponse で応答抽出
  └── 成功 → Discord に投稿 → 完了

Phase 2: claude -p フォールバック（Phase 1 で応答抽出失敗時のみ）
  ├── claude -p "<メッセージ>" --resume <claudeSessionId> --output-format json
  ├── JSON パースで応答取得（確実）
  ├── session_id を DB に保存
  └── Discord に投稿 → 完了

/session stop
  ├── スレッド 🟢→🔴 + アーカイブ
  └── tmux セッションは残す（--resume で調査可能）
```

### フォールバック条件

| 状態 | Phase 1 の結果 | アクション |
|---|---|---|
| 応答あり | `extractResponse` が非空 | Discord に投稿。Phase 2 不要 |
| 応答なし（パーサー失敗） | `isAtPrompt=true` && `extractResponse=""` | Phase 2 へフォールバック |
| 30秒タイムアウト（処理中） | `isAtPrompt=false` && 30秒経過 | 待機継続（最大5分） |
| 5分タイムアウト | `isAtPrompt=false` && 5分経過 | Discord に「タイムアウト」投稿 |
| tmux セッション死亡 | capture-pane がエラー | Phase 2 で新規 `-p` 起動 |

### session ID の管理

- ウェルカムメッセージに tmux session name を表示
- Phase 2 で `claude -p --output-format json` の応答から `session_id` を取得して DB に保存
- session_id 判明後はスレッドに追加投稿

### Discord 表示

ウェルカムメッセージ:
```
✅ OCI Develop のセッションを開始しました
📁 ディレクトリ: /Users/harieshokunin/oci_develop
📊 稼働中セッション: 1/10
🔑 tmux: claude-148799695310
調査用: tmux attach -t claude-148799695310
```

session ID 判明後:
```
🔑 Claude Session: <uuid>
調査用: claude --resume <uuid>
```

## 変更対象

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/session/relay.ts` | Phase 1 タイムアウト30秒化 + Phase 2 フォールバック追加 |
| `src/session/manager.ts` | session ID 保存、stop 時に tmux を残す |
| `src/commands/session.ts` | ウェルカムメッセージに tmux session name 表示 |

### 変更しないファイル

- `src/bot.ts` — メッセージハンドラはそのまま
- `src/infra/db.ts` — claude_session_id カラムは既にある
- `src/session/output-formatter.ts` — parseStreamJsonOutput は既にある
- `src/session/types.ts` — claudeSessionId フィールドは既にある

## テスト方針

- ユニットテスト: Phase 1 → Phase 2 フォールバックロジック
- ユニットテスト: claude -p JSON パース（parseStreamJsonOutput は既存）
- 統合テスト: 実際の tmux + claude -p での E2E
