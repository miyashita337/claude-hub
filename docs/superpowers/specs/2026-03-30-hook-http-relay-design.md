# Issue #4: Hook + HTTP Relay 方式 — 設計書

## 概要

capture-pane スクレイピングを完全に廃止し、Claude Code の Stop フック + HTTP POST で応答を取得する。入力は tmux send-keys を維持。

## 背景

- capture-pane は CRITICAL な欠陥が3つあり、パッチでは根本解決不可能
- 実機検証で Stop フックが**各ターン完了時に発火**し、`last_assistant_message` に完全な応答テキストが含まれることを確認
- Phase 1/Phase 2 フォールバック案はセッション競合・メッセージ重複の致命的欠陥で却下

## アーキテクチャ

### 通信フロー

```
/session start
  ├── Supervisor が HTTP Relay サーバー起動（Bun.serve, localhost:PORT）
  ├── tmux セッション起動
  │   └── 環境変数: SUPERVISOR_RELAY_URL=http://localhost:PORT/relay/{threadId}
  ├── Claude Code 起動（Stop フック付き）
  ├── Discord スレッド作成
  └── iTerm2 タブ（optional）

メッセージ受信（Discord スレッド）
  ↓
Supervisor: tmux send-keys でメッセージ送信
  ↓
Claude Code: 処理実行
  ↓
Claude Code: ターン完了 → Stop フック発火
  ↓
Stop フックスクリプト:
  ├── stdin から JSON 読み取り（last_assistant_message, session_id）
  └── curl POST $SUPERVISOR_RELAY_URL -d '{"text":"応答","session_id":"..."}'
  ↓
Supervisor HTTP サーバー: POST /relay/{threadId} 受信
  ↓
Supervisor: Discord スレッドに応答投稿

画像添付の場合:
  Discord 画像 → Supervisor DL → /tmp に保存
  → tmux send-keys: "Read the image at /tmp/img.png. メッセージ"
  → (以降同じフロー)
```

### 削除するコード

relay.ts から完全削除:
- `capturePaneContent()` — tmux capture-pane ポーリング
- `isAtPrompt()` — プロンプト検知ヒューリスティック
- `extractResponse()` — TUI スクレイピングパーサー
- ポーリングループ（while true + sleep 2s）

### 新規コンポーネント

| コンポーネント | ファイル | 責務 |
|---|---|---|
| Relay HTTP サーバー | `src/session/relay-server.ts` | `Bun.serve()` で `POST /relay/:threadId` を受信。Promise を resolve して応答を返す |
| Stop フックスクリプト | `hooks/stop-relay.sh` | stdin の JSON から `last_assistant_message` と `session_id` を抽出し、`SUPERVISOR_RELAY_URL` に POST |
| Relay 関数（書き換え） | `src/session/relay.ts` | send-keys で入力送信 + Promise で HTTP 応答を待つ |

### Relay サーバー設計

```typescript
// src/session/relay-server.ts
const pendingRequests = new Map<string, {
  resolve: (result: RelayResult) => void;
  timer: Timer;
}>();

Bun.serve({
  port: RELAY_PORT,
  routes: {
    "POST /relay/:threadId": async (req) => {
      const { threadId } = req.params;
      const body = await req.json();
      const pending = pendingRequests.get(threadId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve({
          text: body.text || body.last_assistant_message,
          chunks: formatForDiscord(body.text || body.last_assistant_message),
          claudeSessionId: body.session_id,
        });
        pendingRequests.delete(threadId);
      }
      return new Response("ok");
    },
  },
});
```

### Stop フックスクリプト

```bash
#!/bin/bash
# hooks/stop-relay.sh
# Claude Code Stop フックから呼ばれる。stdin に JSON が渡される。
if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0  # Supervisor 管理外のセッションでは何もしない
fi

INPUT=$(cat)
TEXT=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -n "$TEXT" ]; then
  curl -s -X POST "$SUPERVISOR_RELAY_URL" \
    -H "Content-Type: application/json" \
    -d "{\"text\": $(echo "$TEXT" | jq -Rs .), \"session_id\": \"$SESSION_ID\"}" \
    --max-time 5
fi
```

### relayMessage の書き換え

```typescript
// src/session/relay.ts (書き換え後)
export async function relayMessage(
  tmuxSessionName: string,
  threadId: string,
  message: string,
  options?: { attachments?: AttachmentInfo[]; }
): Promise<RelayResult> {
  // 1. 添付ファイルのダウンロード（既存コード維持）
  // 2. tmux send-keys でメッセージ送信（既存コード維持）
  // 3. Promise を作成して pendingRequests に登録
  // 4. Stop フックからの HTTP POST を待つ（タイムアウト5分）
  // 5. 応答を返す
}
```

### セッション ID の管理

- Stop フックの JSON に `session_id` が含まれる
- 初回ターン完了時に HTTP POST 経由で Supervisor に届く
- DB に保存し、ウェルカムメッセージを編集して表示

### ウェルカムメッセージ

```
✅ OCI Develop のセッションを開始しました
📁 ディレクトリ: /Users/harieshokunin/oci_develop
📊 稼働中セッション: 1/10
🔑 tmux: claude-148799695310
調査用: tmux attach -t claude-148799695310
```

### フォールバック

| 状態 | 対応 |
|---|---|
| Stop フックが5分以内に発火しない | タイムアウト → Discord に「タイムアウト」投稿 |
| Stop フックの curl が失敗 | 無視（Supervisor 側でタイムアウト） |
| tmux セッションが死亡 | send-keys でエラー検知 → Discord にエラー投稿 |
| Supervisor 再起動 | pendingRequests が消失 → 次のメッセージで復帰 |

## 変更対象

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/session/relay.ts` | capture-pane 全削除 → Promise + send-keys のみ |
| `src/session/manager.ts` | SUPERVISOR_RELAY_URL 環境変数を tmux に渡す |
| `src/commands/session.ts` | session_id 表示 |

### 新規ファイル

| ファイル | 内容 |
|---|---|
| `src/session/relay-server.ts` | Bun.serve HTTP サーバー |
| `hooks/stop-relay.sh` | Stop フックスクリプト |

### 削除するコード

- `isAtPrompt()` — 完全削除
- `extractResponse()` — 完全削除
- `capturePaneContent()` — 完全削除
- ポーリングループ — 完全削除

## テスト方針

- ユニットテスト: relay-server の HTTP エンドポイント
- ユニットテスト: Stop フックスクリプトの JSON パース
- 統合テスト: tmux send-keys → Stop フック → HTTP → Discord
- 既存の output-formatter テストはそのまま維持
