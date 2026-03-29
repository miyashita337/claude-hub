# Issue #3: セッションごとにDiscordスレッドで分離 — 設計書

## 概要

`/session start` 実行時に Discord スレッドを自動作成し、Supervisor が Discord ↔ Claude Code 間のメッセージを中継する。`--channels plugin:discord` を廃止し、`claude -p` 都度起動方式に転換する。

## アプローチ

**A方式: claude -p 都度起動 + スレッド分離**

ユーザーがスレッド内にメッセージを送信するたびに、Supervisor が `claude -p` を子プロセスとして起動し、応答をスレッドに投稿する。

## アーキテクチャ

### メッセージフロー

```
Discord Channel: #oci-develop
├─ ユーザー: /session start
│   → Supervisor: スレッド「🟢 Session: oci-develop」作成
│   → DB に threadId + channelName を記録
│
├─ 🧵 スレッド内:
│   ├─ ユーザー: 「ログイン機能を作って」
│   │   → Supervisor: threadId → session マッピング参照
│   │   → claude -p "ログイン機能を作って" --resume <sessionId> --dangerously-skip-permissions
│   │   → stdout パース → スレッドに投稿
│   │
│   ├─ ユーザー: [画像添付] 「このエラーを見て」
│   │   → Supervisor: 画像を /tmp にダウンロード
│   │   → claude -p "このエラーを見て" --file /tmp/error.png --resume <sessionId>
│   │
│   └─ ユーザー: /session stop
│       → スレッドを archive + lock
│
└─ ユーザー: /session start（2つ目）
    → 別スレッド作成（同チャンネル複数セッション可能）
```

### セッション識別の変更

- 現行: `Map<channelName, SessionInfo>` → 1チャンネル1セッション
- 新: `Map<threadId, SessionInfo>` → 1スレッド1セッション（1チャンネルNセッション）

## 変更対象

### 新規ファイル

| ファイル | 責務 |
|---|---|
| `src/session/relay.ts` | MessageRelay: Discord ↔ claude -p 中継 |
| `src/session/output-formatter.ts` | Claude Code stdout → Discord メッセージ分割 |
| `tests/session/relay.test.ts` | MessageRelay のユニットテスト |
| `tests/session/output-formatter.test.ts` | OutputFormatter のユニットテスト |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/session/types.ts` | SessionInfo に threadId 追加 |
| `src/infra/db.ts` | sessions テーブルに thread_id カラム追加 |
| `src/session/manager.ts` | Map キーを threadId に変更、--channels 削除、スレッド管理追加 |
| `src/bot.ts` | スレッド内 messageCreate → relay 呼び出し |
| `src/commands/session.ts` | /session start でスレッド作成、stop でアーカイブ |
| `src/config/channels.ts` | botTokenEnvKey はそのまま残す（既存Bot削除しない） |
| `src/session/reaper.ts` | threadId ベースに対応 |
| `src/session/resource-monitor.ts` | 変更なし（PID ベースのまま） |

### 変更しないファイル

- `src/session/iterm2.ts` — そのまま動作
- `.env` — 既存の Bot Token を残す

## DB スキーマ変更

```sql
ALTER TABLE sessions ADD COLUMN thread_id TEXT;
```

## OutputFormatter 仕様

- Discord メッセージ上限: 2000文字
- コードブロック（```）の途中で分割しない
- 長い出力はファイル添付にフォールバック

## --resume バグ対策

1. プロトタイプでは `--resume` なしで実装（各メッセージが独立会話）
2. 動作確認後、`--resume` を試行
3. セッションファイル消失の場合はワークアラウンド検討

## テスト方針

- ユニットテスト: OutputFormatter, MessageRelay（claude -p はモック）
- 統合テスト: SessionManager のスレッド管理
- E2E: Claude in Chrome でブラウザから Discord で実際に操作
