---
name: "local-e2e-discord"
description: "ローカル Mac で実 Chrome + 実 Discord を使い claude-hub の session 起動経路を E2E 検証する"
version: "1.0"
---

# ローカル Discord E2E 検証コマンド

引数: $ARGUMENTS

手元の Mac で **実 Chrome（Claude in Chrome 拡張）+ 実 Discord ログイン状態** を使い、
`/session start` → Welcome → ping 応答 → `/session stop` → アーカイブ までを一気通貫で検証する。

CI 版（Issue #111）が拾えない以下の局面を対象とする:

- PR を投げる前のローカル pre-flight 確認
- CI fail のローカル再現デバッグ
- supervisor 設計変更時の実 UI 目視（装飾・絵文字レンダリング）
- macOS 固有の flake 調査

> CI（headless / API direct）と本コマンド（実 Chrome）は補完関係。通常の PR 検証は CI 必須 job を使い、
> 本コマンドは「手元確認」「再現デバッグ」「目視」に使う。

## 前提条件（満たさない場合は手順 0 で停止）

| 前提 | 確認方法 | 不足時 |
|---|---|---|
| Chrome に Claude in Chrome 拡張がインストール済み | `mcp__claude-in-chrome__list_connected_browsers` | README の導入手順を案内して停止 |
| Discord に **ログイン済み**のタブが Chrome にある | navigate 後にログイン画面でないこと | 「Discord にログインしてください」と出力して停止 |
| Supervisor Bot が稼働中 | `launchctl list \| grep com.claude-hub.supervisor` または `pgrep -f supervisor` | supervisor 停止状態は **失敗ケース検証**（後述）でのみ許容 |

## 引数 / オプション

| オプション | 既定値 | 意味 |
|---|---|---|
| `--channel <name>` | `openclaw-rpi5-ops` | 対象チャンネル名 |
| `--branch <name>` | `local-e2e-test` | `/session start <branch>` に渡す branch（**#175 で branch 必須化**。使い捨て名を使う） |
| `--message <text>` | `echo "ping" を実行して結果だけ返して` | ping 代わりに送るメッセージ |
| `--timeout-welcome <ms>` | `5000` | Welcome 待ち timeout |
| `--timeout-response <ms>` | `30000` | 応答待ち timeout |
| `--keep-thread` | off | 終了後に `/session stop` を送らず thread を残す（デバッグ用） |
| `--skip-stop` | off | `/session stop` 検証をスキップ（手順 4.5 の resume も行わない） |
| `--skip-resume` | off | 手順 4.5（`/session resume` 検証）をスキップ |
| `--expect-fail` | off | supervisor 停止状態での **失敗ケース検証**（Welcome timeout → FAIL を期待値とする） |

> **重要（#175 補正）**: Issue 本文の初版は無引数 `/session start` を想定していたが、現行仕様では
> `/session start <branch>` の **branch 引数が必須**。本コマンドは `--branch`（既定 `local-e2e-test`）を必ず付けて送る。

## 検証フロー

各ステップで `mcp__claude-in-chrome__*` を使う。tool は呼ぶ前に ToolSearch で読み込むこと。
DB / プロセスの polling は bash で行う。**各待機は固定 sleep ではなく polling**（RW-025 教訓）。

### 手順 0: 前提チェック

```bash
# Supervisor 稼働確認（--expect-fail 時は停止していることを期待）
pgrep -f "supervisor" >/dev/null && echo "supervisor: running" || echo "supervisor: stopped"
# sessions.db の場所（環境変数優先、既定は ~/claude-hub/supervisor/sessions.db）
DB="${SUPERVISOR_DB_PATH:-$HOME/claude-hub/supervisor/sessions.db}"; echo "db=$DB"
```

`mcp__claude-in-chrome__list_connected_browsers` で拡張接続を確認。未接続なら停止。

信頼されていないフォルダでの起動（フォルダ信頼の確認画面を Supervisor が承認する経路、#569 / #571）は
Discord 経由では再現できない（対象チャンネルのフォルダが信頼済みだと画面が出ない）ため、実機検証ツールで別に確かめる:

```bash
bun supervisor/tools/verify-folder-trust.ts   # PASS: all cases / exit 0 を期待
```

### 手順 1: Discord チャンネルへ navigate

1. `mcp__claude-in-chrome__tabs_context_mcp` で既存タブを確認
2. Discord タブがあれば再利用、なければ `tabs_create_mcp` で新規
3. 対象チャンネルの Discord URL に `navigate`
4. **検証**: 現在タブの URL が `discord.com/channels/` を含むこと（ログイン画面でないこと）

### 手順 2: `/session start <branch>` 送信 → Welcome 検出

1. T0 を記録（bash `date +%s%3N`）
2. メッセージ入力欄を `find` でクリック → `/session start` を入力 → 半角スペース → branch 名入力 → Discord の slash UI を確定（Tab → Return）
3. **DB polling**（`--timeout-welcome` まで、0.5s 間隔）:

   ```bash
   DB="${SUPERVISOR_DB_PATH:-$HOME/claude-hub/supervisor/sessions.db}"
   # channel_name 一致かつ status='running' の row が出現するまで待つ。
   # <channel_name> は --channel の値（既定 openclaw-rpi5-ops）に置換する。
   sqlite3 "$DB" "SELECT id,thread_id,status FROM sessions WHERE channel_name='<channel_name>' AND status='running' ORDER BY started_at DESC LIMIT 1;"
   ```

4. Welcome 表示を `gif_creator` または screenshot で撮影
5. **検証**: screenshot に `✅` と「セッションを開始しました」または「スレッドで起動しました」が含まれること
6. `--expect-fail` 時: Welcome が timeout すれば **期待どおり**（この時点で FAIL レポートを出力して終了）

### 手順 3: thread に入り ping 送信 → 応答検出

1. 手順 2 で得た `thread_id` の thread リンクをクリックして遷移
2. T1 を記録
3. `--message` の本文を thread に送信
4. **応答 polling**（`--timeout-response` まで）: thread 内に応答メッセージが現れるまで `read_page` / `find` でチェック
5. 応答 screenshot を撮影
6. **検証**: screenshot に `ping` 出力が含まれること

### 手順 4: `/session stop` → アーカイブ検出

`--keep-thread` / `--skip-stop` 指定時はスキップ。

1. thread 内で `/session stop` を送信
2. **検証**: 返信 `🛑 セッションを停止しました` が表示され、thread title の先頭が 🟢 → 🔴 に変わること
3. **DB 検証**: 該当 row の `status` が `running` 以外（stopped）になること

   ```bash
   sqlite3 "$DB" "SELECT status,stopped_reason FROM sessions WHERE id='<session_id>';"
   ```

4. アーカイブ screenshot を撮影

`stopped_reason` は停止処理の途中で一時的に `tmux_exited` になり、その後 `manual` で確定する
（高負荷時は数十秒かかる）。`stopped` になった時点で PASS とし、理由は確定後の値を記録する。

### 手順 4.5: `/session resume <session_id>` → 会話の引き継ぎ確認

`--keep-thread` / `--skip-stop` / `--skip-resume` 指定時はスキップ。会話の中身が引き継がれたことまで確かめるため、
手順 3 の後（手順 4 の前）に、スレッドで次の合言葉を覚えさせておく:

- `合言葉は ringo です。覚えたら OK とだけ返して` → `OK` が返ること

手順 4 で止めた後:

1. 停止した行の `claude_session_id` を取得

   ```bash
   sqlite3 "$DB" "SELECT claude_session_id FROM sessions WHERE thread_id='<手順 2 の thread_id>';"
   ```

2. **親チャンネル**（スレッド内ではない）で `/session resume` → `session_id` に上の値を入力 → Return
3. **DB polling**: 同じ `claude_session_id` で `status='running'` の新しい行が出るまで待つ。
   大きい会話や高負荷時は resume の準備に時間がかかるため、最大 5 分待つ（#163）

   ```bash
   sqlite3 "$DB" "SELECT thread_id,status FROM sessions WHERE claude_session_id='<id>' AND status='running';"
   ```

4. **検証**: 新しいスレッド（タイトル先頭 ♻️）に「♻️ … のセッションを復帰しました（resume）」が表示されること。
   停止時に消えた worktree は作り直される（ログに `Re-created worktree for branch`、#217）
5. 新しいスレッドで `さっきの合言葉は？単語だけ返して` を送信し、**`ringo` が返ること**（＝会話履歴が引き継がれた）
6. 新しいスレッドで `/session stop` を送り、手順 4 と同じく `stopped` を確認

### 手順 5: レポート出力

下記フォーマットで 1 メッセージにまとめて出力する。

```markdown
## ローカル E2E 検証結果 - YYYY-MM-DD HH:MM

| ステップ | 期待 | 実測 | 判定 |
|---|---|---|---|
| /session start → Welcome 表示 | < 5s | 4.2s | ✅ |
| Welcome → ping 応答 | < 30s | 28.7s | ✅ |
| /session stop → アーカイブ | < 5s | 3.1s | ✅ |
| /session resume → 復帰スレッド | < 5min | 32s | ✅ |
| 復帰後に合言葉 → `ringo` | < 30s | 9.8s | ✅ |
| 総合 | 全 PASS | 5/5 PASS | ✅ |

スクリーンショット:
- ss_xxxx (welcome 表示)
- ss_yyyy (ping 応答)
- ss_zzzz (stop 完了)

load average: 12.5 / 15.2 / 18.3
```

失敗時は該当ステップを `❌` にし、timeout 理由・失敗時点の screenshot を必ず含める。

## 失敗ケース検証（`--expect-fail`）

supervisor を停止した状態で実行し、Welcome が timeout することを確認する:

```bash
# supervisor を一時停止（手動 or launchctl unload）
launchctl unload ~/Library/LaunchAgents/com.claude-hub.supervisor.plist
```

→ 手順 2 で Welcome timeout → レポートに `❌` + timeout 理由が出れば **期待どおり PASS**。
検証後は supervisor を復帰させること（`launchctl load ...`）。

## リスク / 留意点

- **Chrome タブ状態依存**: Discord ログイン前提。ログアウト時は手順 1 で停止し明示エラー。
- **CiC 拡張 install 必須**: 未接続なら手順 0 で停止。
- **selectors の brittleness**: Discord UI 更新で `find` が 0 件になりうる → role-based selector を fallback で試す。
- **同時実行不可**: 1 Chrome ウィンドウ 1 セッション。並列実行は想定しない。
- **テスト thread / worktree が残る**: 失敗時 / `--keep-thread` 時は thread と `local-e2e-test` branch の worktree を手動 cleanup（README 参照）。
- **branch 必須**: `--branch` は使い捨て名を使う。既存の作業 branch を指定しないこと（worktree 共有事故 RW-046 回避）。

## ダイアログ注意

JavaScript alert/confirm/prompt をトリガーする操作は避ける（拡張がブロックされ後続コマンドが届かなくなる）。
デバッグは `console.log` + `read_console_messages` を使う。

## 関連

- 親概念: Issue #111（CI 版 Discord E2E）
- 補完: Issue #107（最終チェックゲート）Phase 2 の手作業を本コマンドで半自動化
- 既存メモリ: `feedback_chrome_verification.md`（Chrome 動作検証必須ルール）
- session 実体: `supervisor/src/commands/session.ts`, `supervisor/src/infra/db.ts`, `supervisor/src/session/thread-title.ts`
