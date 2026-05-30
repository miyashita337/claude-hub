# セッション生死＋ID サルベージの統一化 — 設計 (Phase 1)

- 日付: 2026-05-30
- 対象: claude-hub Supervisor
- ステータス: 設計承認済 (ユーザー壁打ちで合意)

## 背景 / 問題

Discord スレッド経由で Claude Code セッションを操作する Supervisor で、以下が再発している（agent-base / team-salary 他、全チャンネル共通）:

1. **死んだスレッドで話しかけても沈黙する**。`bot.ts:209` がアクティブセッション無しのスレッドのメッセージを silent ignore するため、`@Channel-Supervisor` でも `@claudeHubExit` でも応答が返らない。
   - 実ログ証拠: `[Bot] Ignoring message in thread 1507998437201936385 (no active session)` ×3
2. **resume に必要な `claude_session_id` が取れない**。

### データ実測 (sessions.db)

```
全 1018 セッション中、claude_session_id 取得済 = 101 件 (≈10%)
```

- `thread_id` は全件取得済 → スレッド↔セッション対応は堅牢。
- 欠けているのは resume に必要な `claude_session_id` のみ。
- **running 状態でも MISSING が混在** = 捕捉タイミングが不安定。

### 根本原因

`claude_session_id` の捕捉が `bot.ts:319` の **relay 成功時のみの opportunistic 方式**。relay がタイムアウトする（ログ上頻発）と ID は永久に NULL のまま。

## ゴール / 非ゴール

### ゴール (Phase 1)
- どのチャンネルでも、スレッドの生死とセッション ID を確実に取得・提示できる。
- `claude_session_id` を 100% 捕捉する。
- 死んだスレッドが沈黙せず、救済情報を返す。
- resume の二重起動を構造的に防止する。

### 非ゴール
- ワンクリック resume (ボタン/リアクションでの復帰自動化) — Phase 1 では含めない。
- Supervisor プロセス自体が死んだ場合の独立監視 — Phase 2 (別設計)。

## 重要な発見: `claude --session-id <uuid>`

`claude` CLI (Claude Code 2.1.158) に `--session-id <uuid>` flag が存在する（"Use a specific session ID for the session"）。
Supervisor 側で UUID を生成 → 起動時に付与 → 即 DB 保存することで、relay 成否に依存しない **100% 確定捕捉**が可能。脆い検出（transcript 監視・画面パース）は不要。

### capture アプローチ比較

| 案 | 方法 | 捕捉率 | 脆さ | 採否 |
|---|---|---|---|---|
| C: `--session-id` 注入 | 起動時に Supervisor が UUID 生成・付与・即保存 | 100% | 無 (CLI 公式 flag) | **採用** |
| A: transcript 監視 | `~/.claude/projects/<key>/*.jsonl` 監視 | 高 | 中 | 不採用 (保険候補) |
| B: 画面パース | capture-pane で起動バナーから抽出 | 中 | 高 (RW-020/027 の轍) | 不採用 |

## アーキテクチャ / コンポーネント

すべて **Supervisor 単一プロセス + 単一 sessions.db** に載せるため、全チャンネルへ自動的に統一適用される（チャンネルごとの bot 増設は不要）。

| コンポーネント | 場所 | 役割 |
|---|---|---|
| **session-id 注入** | `session/manager.ts` (start/resume の spawn) | `crypto.randomUUID()` 生成 → `claude --session-id <uuid>` で起動 → DB に即保存。relay 遅延捕捉は idempotent fallback 化 (NULL の時のみ set) |
| **thread→session 逆引き** | `infra/db.ts` | `getSessionByThreadId(threadId)` を追加 (最新行 `started_at DESC LIMIT 1`) |
| **権威ある liveness 判定** | `session/manager.ts` (新ユニット) | DB status + 実 pid 生存 (`process.kill(pid,0)`) + tmux セッション存在 を突き合わせ `alive \| dead \| unknown` を返す。salvage 応答と resume guard が共有する唯一の真実 |
| **dead-thread 救済応答** | `bot.ts:209` (現 silent ignore) | liveness 判定 → 「生存(スレッド X)」/「死亡 (stopped_reason + claude_session_id + `/session resume <id>` 文)」/「履歴なし」を返信 |
| **status トークン / `/session status`** | `bot.ts` / `commands/session.ts` | live/dead 問わず現スレッドの生死＋ID を返す。明示トークンのみ発火 (`/session status` か `@Supervisor status` 完全一致)。自然言語推測はしない |
| **resume single-flight 安全化** | `session/manager.ts` / `commands/session.ts` | claude_session_id をキーに「どこかで alive なら拒否＋稼働中スレッド案内」。in-flight ロックで TOCTOU を封じる。resume 行も claude_session_id を確実保存 |

## データフロー

```
起動:  /session start → uuid=randomUUID()
        → spawn `claude --session-id uuid`
        → insertSession(claude_session_id=uuid, thread_id, status=running)   ← 100% 捕捉

問合せ: thread T のメッセージ
        ├ アクティブ有 → 従来通り中継 (status 明示トークンのみ横取り)
        └ アクティブ無 → liveness(T) → 救済応答 (沈黙廃止)

resume: /session resume <id>
        → liveness(id) が alive のどこか → 拒否 + 稼働中スレッド案内
        → in-flight ロック取得 → spawn `claude --resume <id>` (--session-id は付けない)
        → insertSession(claude_session_id=id, ...)
```

## エラー処理 / エッジ

- **resume 経路との衝突**: 新規起動のみ `--session-id`、`--resume <id>` 時は付けない (分岐)。`--fork-session` は使わず full session 維持 (#163/#164 の方針踏襲)。
- **過去セッション (ID 未記録の 9 割)**: 救済応答は degrade — 「ID 未記録 (機能導入前)。`/session start` で新規起動を推奨」と明示。
- **status 誤爆防止**: live スレッドでは明示トークンのみ横取り。自然言語推測はしない (RW-020/027 の教訓)。
- **DB status 陳腐化**: ガードは DB status を信用せず実 pid/tmux を突き合わせる (穴 A)。
- **claude_session_id NULL でガード不能** (穴 B): 注入＋resume 行保存で必ず引けるようにする。
- **同 ID をほぼ同時に resume** (穴 C, TOCTOU): in-flight ロック (claude_session_id キー) で封じる。RW-046 (共有 worktree 二重利用) 同型。
- **thread 再利用で複数行**: `started_at DESC LIMIT 1` で最新を返す。

## テスト

- spawn 引数に `--session-id` が入り DB 行へ即反映 (mock spawn)。
- `getSessionByThreadId` が最新行を返す。
- liveness 判定: DB running + pid 死 → `dead` に矯正 / pid 生 + tmux 有 → `alive`。
- dead-thread が沈黙せず救済応答 / DB 無 → 「履歴なし」。
- status トークン: 完全一致のみ発火、通常作業メッセージは中継 (誤爆ガード)。
- resume single-flight: 同 ID 同時 resume の 2 本目が拒否される。
- 回帰: resume 経路が壊れない・`--session-id` と `--resume` を二重付与しない。

## Phase 2 (後続・別設計)

- Supervisor プロセス自体の死を、claudeHubExit と同様の独立 watchdog が別経路で検知・応答する。
- Phase 1 完了後に別 Epic 子 / 別 spec で設計する。

## 受け入れ基準 (統合ジャーニー)

1. **操作**: 死んだスレッドで `@Channel-Supervisor` にメンション。
   - **期待結果**: 沈黙せず「死亡 / stopped_reason / claude_session_id / resume コマンド文」が返る。
   - **検証手段**: Discord 応答本文に claude_session_id と `/session resume` を含む。
2. **操作**: `/session start` で新規セッション起動 → 直後に sessions.db を確認。
   - **期待結果**: 当該行の `claude_session_id` が即時に非 NULL。
   - **検証手段**: `sqlite3 sessions.db "SELECT claude_session_id FROM sessions WHERE thread_id=...;"` が UUID。
3. **操作**: 稼働中セッションの claude_session_id を 2 つのスレッドからほぼ同時に `/session resume`。
   - **期待結果**: 1 本目のみ起動、2 本目は「既に稼働中」で拒否。
   - **検証手段**: tmux セッション数が増えない / 2 本目応答が拒否メッセージ。
