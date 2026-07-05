# /orchestrate 実 Discord E2E（Epic #316 Phase 4 / #321）

実際の Discord をコードから駆動して `/orchestrate` と claude-hub work 経路（ADR-002 D5）の
振る舞いを自動検証し、あわせて既存機能（relay / session lifecycle / dispatch）の hermetic
回帰を 1 コマンドで実行する。

## 実行（1 コマンド）

```bash
bash scripts/e2e-orchestrate.sh                  # hermetic 回帰 + ライブ E2E
bash scripts/e2e-orchestrate.sh --skip-live      # hermetic 回帰のみ（ライブ手順をスキップ = CI 安全）
bash scripts/e2e-orchestrate.sh --keep           # 残骸を残す（デバッグ）
bash scripts/e2e-orchestrate.sh --full           # S1 の最終レポート到達まで待つ（Phase 5 向け）
```

終了時に PASS/FAIL/SKIP のサマリ表を出力し、FAIL が 1 件でもあれば exit 1。

## 前提（手動準備・初回のみ）

| # | 準備 | 理由 |
|---|---|---|
| 1 | Supervisor が **PR #325 以降**のコードで稼働（`launchctl kickstart -k "gui/$UID/com.claude-hub.supervisor"`） | `/orchestrate`（PR #324）と `POST /hub-work`（PR #325）が必要。プリフライトが `/hub-work` の 400 応答で機械確認する。**注意: Supervisor 再起動は running 中の全セッションを stop する**（`supervisor_restart`。worktree は保持され `/session resume` で再開可能）。再起動前に `bun run supervisor/tools/session-ctl.ts list` で確認すること |
| 2 | driver Bot token が `supervisor/.env` にある（既定: `VIDEO_QA_BOT_TOKEN`。`E2E_DRIVER_TOKEN_ENV` で変更可） | テストドライバは Supervisor とは別 Bot として corp へ投稿する |
| 3 | `~/.claude/channels/discord/access.json` の corp グループ `allowFrom` に driver Bot の user id を追加 | `/orchestrate` の認可は `allowFrom`（bot.ts はこの経路を bot ドロップより前にインターセプト）。**この許可で widening するのは /orchestrate 起動のみ** — 通常スレッド relay は `message.author.bot` で落ちるため、driver Bot が既存セッションを操作できるようにはならない |
| 4 | `orchestrate-runner` スキルが install 済み（`~/.claude/skills/orchestrate-runner/`） | S1 のオーケストレーター頭脳（agent-base PR #453） |

プリフライトが 1〜4 を機械チェックする。1・2・4 の不足は FAIL + 対処を出力して停止（fail-closed）。
3（allowFrom）のみ未実施の場合は、`/orchestrate` 駆動シナリオ（S1 / S2-*）を SKIP として明示レポートし、
認可不要の S1b（loopback の `POST /hub-work`）と S3 は実行する（部分縮退）。
ドライバは access.json を**読み取り検査するだけで書き換えない** — 認可の追加は owner の明示操作とする。

## シナリオと検証手段

| ID | シナリオ | 層 | 検証手段 |
|---|---|---|---|
| S2-1 | 空引数 `/orchestrate` → fail-closed（セッション未起動） | Supervisor（決定的） | corp に「⚠️ 引数が空です」+ sessions.db に orchestrate-* 増加なし |
| S2-3 | 存在しない .tmp → スキル層 fail-closed | スキル（モデル依存） | セッションは起動する（ADR-002 D2: Supervisor は引数を解釈しない）。スレッドにエラー報告 + ワーカー/Issue 増加なしを 8 分待ちで確認 |
| S2-2 | 多重 `/orchestrate` → 2 本目は案内のみ | Supervisor（決定的） | 「ℹ️ 既にオーケストレーターが稼働中」+ セッション増加なし |
| S1-a | 正常系起動（.tmp 1 + テスト Issue 1） | Supervisor（決定的） | orchestrate-* running 行 + スレッド + 🎼 welcome（引数エコー一致） |
| S1-b | .tmp → Issue 化（P2 AC-1） | スキル | `[e2e-test]` Issue の新規作成を gh でポーリング |
| S1-c | Mermaid 進捗ダッシュボード（P2 AC-5） | スキル | スレッドに ```` ```mermaid ```` ブロック |
| S1-d | ワーカー起動（hub work 経路） | スキル + Supervisor | sessions.db に `channel_name='claude-hub-work'` 行 |
| S1-e | 完了 → 最終レポート | スキル | `--full` 時のみ（Phase 5 受け入れ実走で使用） |
| S1b | hub work 経路の直接 smoke（start-hub-worker → send → stop） | session-ctl（決定的） | DB 行 / thread / stop 反映 / hijoguchi 投稿ゼロ |
| S3 | 既存機能回帰 | hermetic + live | CI と同一の e2e スイート + dispatch/orchestrate/hub-work ユニット + hijoguchi pid 不変 + session-ctl list |

### Phase 5 送り（本 E2E では SKIP として明示レポート）

| 項目 | 理由 |
|---|---|
| S2-4 error loop（故意失敗 3 回 → 停止、P2 AC-3） | error loop 検知はオーケストレーター（モデル）の意味判断で、決定的な PASS/FAIL アサートが書けず 30 分超かかる。実走（#322）で観測する |
| S2-5 kill → resume 再入（P2 AC-4 smoke） | resume は Epic 番号前提（SKILL Phase E）。テスト用 Epic の常設はテスト残骸になるため実走で検証。corp 台帳の冪等性（重複投入なしの土台）は agent-base `tests/test_orchestrate_runner.sh` で担保済み |
| /session start\|list\|stop\|resume の実 Discord slash 駆動 | **Bot は他 Bot の slash command を実行できない**（Discord 制約）。hermetic 回帰（session lifecycle / commands テスト）+ `.claude/commands/local-e2e-discord.md`（Chrome 手動）でカバー |
| hijoguchi メンション応答 | `allowFrom=[owner]` のため owner アカウントからのみ発火できる（driver Bot では原理的に不可）。実走時に目視 |

## 課金・外部影響ガード（AC-4）

- テスト Issue はタイトル先頭 `[e2e-test]` + 本文に「実装せず `e2e-ack` コメントのみ」の指示
- ドライバ自体に Pushover / SNS / 外部課金 API を呼ぶ経路はない（Discord REST + sessions.db read-only + gh のみ）
- 終了時 cleanup: 起動セッション stop → テスト由来 open PR close → テスト Issue close →
  worktree / local・remote branch 削除 → スレッド archive → テスト .tmp 削除（`--keep` で温存）

## CI 組み込み

hermetic 部分（wrapper の [1/2]）は既存 CI と同一スイートのため常時 green が前提。
ライブ部分は Discord 実トークン + 稼働中 Supervisor が必要なためローカル実行専用とし、
PR ゲート化は #78 と同じ WARN-first 段階導入として follow-up Issue で追跡する。

## 関連

- Issue #321 / Epic #316 / ADR: `docs/adr/2026-07-05-corp-orchestration.md`
- 既存資産: `supervisor/tests/e2e/README.md`（AC-1..7）, `.claude/commands/local-e2e-discord.md`（Chrome 手動）
- スキル: agent-base `skills/orchestrate-runner/`（PR #453 + 契約同期 PR #454）
