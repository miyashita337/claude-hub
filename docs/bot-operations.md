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
- **コマンド**: `/session start|stop|list|status|resume|compact`（`compact` は Issue #200。primary channel での compact は Issue #199 AC1、下記 §「Required env vars (Supervisor ...)」参照）
- **メッセージ中継**: Discord thread ↔ tmux send-keys ↔ Claude Code

### 2. claudeHubExit（旧 PM-Agent）
- **対象**: `~/claude-hub` 自体のメンテナンス専用
- **方式**: Claude Code `--channels plugin:discord@claude-plugins-official` 直結
- **起動**: `tmux -CC new-session ... --channels plugin:discord@claude-plugins-official`
  - `CLAUDE_HUB_UNSAFE_SKIP_PERMISSIONS=1` （Phase 1 default）の場合のみ `--dangerously-skip-permissions` を追加。詳細は本 doc 下部の「Permission Mode (claudeHubExit)」参照
- **役割**: **Channel-Supervisor 自身が壊れた時の非常口**
- **idle context リセット（Issue #110）**: 1 つの長命 Claude Code session が Discord メッセージを蓄積し続けると context が無制限に膨らみ、auto-compact が非決定的に発火して応答が止まる。`scripts/hijoguchi-record-activity.sh`（UserPromptSubmit hook）が各受信メッセージの epoch を `~/.claude-hub-state/last-message-ts` に記録し、`start-hijoguchi.sh` の watchdog が `HIJOGUCHI_IDLE_RESET_MIN` 分（default 1440 = 24h）アイドルなら tmux session を kill → fresh で再起動する。半日〜1日程度の放置では reset されず保守スレの文脈が保たれる（短すぎる閾値による「半日後に保守議題へ返信したら記憶ゼロ」を回避）。
  - 閾値は launchd plist の `HIJOGUCHI_IDLE_RESET_MIN` で上書き可能。`0` で機能無効化（オプトアウト）
  - hook は `CLAUDE_HUB_HIJOGUCHI_SESSION=1`（watchdog が export）でスコープされるため、開発者が `~/claude-hub` で素の `claude` を起動しても idle timer は温まらない
  - 既知の制限: idle 判定は「最終メッセージ受信時刻」のみを見る。閾値が短く（テスト用 1 分等）かつ受信直後に長時間 tool 実行が続くケースでは理論上 reset され得るが、default 1440 分では受信から 24h 後に tool 実行中という状況は事実上発生しないため許容する。仮に reset が tool 実行中に起きても、watchdog が tmux session を kill → launchd KeepAlive 相当の outer loop が fresh で再起動するだけで復旧する（context を意図的に捨てる設計なので中断自体が許容される）
  - state file ディレクトリが作成不能な場合、baseline 書き込みは WARN を残して継続し、idle 判定は fail-safe で KEEP（reset 無効）になる。watchdog 本来の責務（クラッシュ時の再起動）は idle 機能の失敗で止めない設計

## 絶対ルール

> **Channel-Supervisor の `CHANNEL_MAP` に `claude-hub` を追加してはいけない**

理由: メタ依存（Supervisor のバグ修正を同じ Supervisor 経由で行う構造）になると、Supervisor がクラッシュした瞬間に Discord 経由での復旧経路が失われる。必ず claudeHubExit という独立した経路を残す。

## 運用シナリオ

### 通常作業（外部プロジェクト）
1. Discord サーバの対象チャンネル（例 `#dev-tool`）で `/session start <branch>`（branch 引数は必須。Issue #154）
   - 指定した branch 専用の git worktree（`<projectDir>/.claude/worktrees/<branch>`）を作成・再利用し、その中で claude を起動する
   - 既存 branch → checkout で worktree 作成 / 未存在 branch → repo の default branch から派生して新規作成
   - 同じ branch で再度 `/session start <branch>` すると既存 worktree を再利用（継続作業）
2. 作成されたスレッドにメッセージを送信 → Channel-Supervisor が Claude Code に中継
3. 終了時は `/session stop`（worktree は削除されるが branch は repo に保持される）

### 既存スレッドにセッションを常駐させる（Issue #453）

`/session start <branch>` を**スレッド内**で実行すると、新しいスレッドを作らず**そのスレッドに**セッションを bind する。

- 対象: 稼働中セッションを持たないスレッド（bot が API で作ったスレッドを含む。例: corp の決裁フィードバックスレッド #449 / corp#127）
- bind 後は通常のセッションスレッドと同じ挙動（発言が中継され、`/session status` `/session stop` `/session compact` が効く）
- アーカイブ済みスレッドは bind 時に自動でアーカイブ解除する（ロック済みスレッドは失敗を返す）
- **既に稼働中セッションを持つスレッド**で実行した場合は従来どおり親チャンネルに新スレッドを作る（同一スレッドから 2 本目のセッションを開始する動線は不変）
- チャンネル直下での実行も従来どおり新スレッド作成（挙動不変）
- アクセス制御は不変: 親チャンネル id に対する `allowFrom` で判定するため、親チャンネルが未許可のスレッドには bind できない

> 制約: セッション付与は人間の `/session start` が起点であることは変わらない。bot 作成スレッドへの**自動**起動（人間の最初の発言でセッションを立てる）は Issue #454 で別途検討する。

### 停止したセッションを着信メッセージで自動復帰する（Issue #456）

セッションは放置で終了する（supervisor 再起動 = `supervisor_restart`、DispatchHealthReaper、idle reaper）。**セッション履歴が残るスレッドに次のメッセージが着信したら、supervisor がそのセッションを同じスレッドへ自動 resume して応答する**（message-triggered wake）。数時間〜数日単位で断続するラリー（corp の決裁フィードバックスレッド等）で、毎回手動 `/session resume <id>` を打つ必要がなくなる。

- 対象: `sessions.db` に thread → session の行があり、`claude_session_id` が記録されていて、権威的 liveness 判定（#168）が `dead` のスレッド
- 復帰先は**そのスレッド自身**（新スレッドを作らない）。復帰後、wake の契機になったメッセージはそのままセッションへ中継される
- 復帰時はスレッドに `♻️ セッションが停止していたため自動で復帰しました` を post する（supervisor ログには `[AutoResume]` 行が残る）
- **履歴のないスレッドでは何もしない**: 従来どおり案内のみで、セッションを勝手に新規起動しない
- **失敗は fail-loud**: MAX_SESSIONS 満杯 / worktree 消失 / チャンネル未登録などで復帰できない場合、`⚠️ 自動復帰できませんでした` + 手動 resume コマンドをスレッドへ返す（黙って落とさない）
- **プロセス生存中で Supervisor が追跡を見失っただけ**のセッションは resume しない（同一 cwd での二重 `claude --resume` は transcript を壊す。RW-046）。従来どおり salvage 案内を返す
- 何度でも発動する（1 回きりではない）。復帰したセッションが再び終了すれば、次の着信でまた復帰する
- アクセス制御は不変: `evaluateAccess` を通過したメッセージだけが wake の契機になるため、`requireMention=true` のチャンネルではメンション時のみ発動する
- 失敗理由のうち **Discord に出るのは定型文だけ**。`resumeSession` の生エラーは worktree 再生成失敗時に `projectDir` の絶対パスを含むため、生原因は supervisor ログにのみ残す（#236 / `RELAY_ERROR_USER_MESSAGE` と同じ契約）

**kill-switch**: `AUTO_RESUME_DISABLED` を `0` 以外の値で設定するとこの経路だけを止められる（`CORP_BRIEF_WINDOW_DISABLED` と対称）。止めると #456 以前の挙動（salvage 案内のみ）に戻り、セッションは起動しない。誤 wake や連続失敗を bot 全体の停止なしに退避するための手段。

> **運用上の制約（同一 `projectDir` の同時 wake）**: supervisor 再起動直後は多数のスレッドが同時に dead になるため、着信のたびにこの経路へ来る。同一チャンネルの**非 worktree**セッションは `projectDir` を共有するので、短時間に複数スレッドが復帰すると既知の relay-url 衝突（応答が別スレッドへ出る）を手動 resume より起こしやすい。多数の dead スレッドが一斉に動きそうな場面では、`AUTO_RESUME_DISABLED=1` で止めて順に手動 resume するか、worktree 運用のチャンネルを使うこと。

実装: `supervisor/src/session/auto-resume.ts`（判定 + 実行）、`supervisor/src/bot.ts` の `messageCreate`（`sessionManager.has(threadId)` が false の分岐）。

> 同じ分岐にある **#454 の朝レポ窓口の遅延再起動が先に走る**。窓口スレッド（`朝レポ窓口 <日付>`）は `/brief-window` を再注入して起動し直す専用経路を持ち、引き金の発言は中継せず「もう一度送ってください」と案内する（起動直後の TUI への入力取りこぼし対策。RW-025 / RW-047）。窓口以外のスレッドはスレッド名判定で素通りし、本節の自動 resume に落ちる。

### claude-hub 自体の修正
1. Discord DM の `claudeHubExit` Bot を使用
2. `--channels plugin:discord` 直結モードで Claude Code が動作
3. Channel-Supervisor の状態に依存せず作業可能

### Channel-Supervisor 復旧
1. `supervisor.stderr.log` を確認
2. 必要なら `claudeHubExit` 経由で修正
3. ローカルで `launchctl kickstart -k gui/$(id -u)/com.claude-hub.supervisor`

> **警告（Issue #369）**: supervisor の再起動（`launchctl kickstart -k ... com.claude-hub.supervisor`）を
> **supervisor 管理下のセッション内から実行してはならない**。SIGTERM → `shutdownAll()` が実行中の
> 全セッション（自分自身を含む）を stop するため、実行したセッションはコマンドの途中で kill され、
> handoff に「supervisor 再起動」が残っていると resume のたびに同じ地点で自死するループになる。
> 再起動は必ずセッション外（ローカルターミナル / claudeHubExit 経由）から実行すること。
> なお shutdown で停止したセッションは `stopped_reason=supervisor_restart` で記録され、
> worktree は保持される（`/session resume` で再開可能）。ユーザーの明示的な `/session stop`
> （`stopped_reason=manual`）のみが worktree を削除する。

## 関連ファイル

- `supervisor/src/config/channels.ts` — CHANNEL_MAP 定義 + claude-hub ガード
- `supervisor/com.channel.supervisor.plist` — launchd plist (caffeinate wrapper 付き)
- `~/Library/LaunchAgents/com.claude-hub.supervisor.plist` — 実際にロードされている plist
- `~/claude-hub/logs/supervisor.{stdout,stderr}.log` — supervisor ログ
- `scripts/list-mcp-load-time.sh` — 各設定での cold-start 計測 (Issue #104 / Epic #101)

## メンテナンスジョブ: 添付ファイルの日次 GC (Issue #151 / #280)

Discord 添付の保存先 `tmp/attachments` を毎日 04:00 に GC し、30 日超のファイルを削除する launchd ジョブ。**セットアップ時に手動インストールが必要**（supervisor 本体とは独立。未インストールだと GC が動かず添付が無限に溜まる — #280 で実際に未設置のまま放置されていた）。

```bash
bash scripts/install-gc-attachments.sh              # 設置 + load（冪等）
bash scripts/install-gc-attachments.sh --uninstall  # 撤去
launchctl kickstart -k gui/$(id -u)/com.claude-hub.gc-attachments  # 手動即時実行
```

- Label: `com.claude-hub.gc-attachments` / テンプレート: リポ直下 `com.claude-hub.gc-attachments.plist`
- ログ: `logs/gc-attachments.{stdout,stderr}.log`（正常時は `[gc-attachments] done: N deleted, M kept`）
- テスト: `bash scripts/test-install-gc-attachments.sh`（launchctl に触らず生成・冪等性のみ検証）

## Cold-start プロファイル (Issue #104)

Channel-Supervisor 経由で起動する Claude Code セッションは、デフォルトで以下のフラグを付与する（`supervisor/src/session/manager.ts` の `buildClaudeFlags()`）。

| フラグ | 効果 | 戻し方 |
|---|---|---|
| `--no-chrome` | claude-in-chrome 連携を skip。paired Chrome extension の init が省略される | `ChannelConfig.chromeEnabled = true` |
| `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | 全ての user-scope MCP server (Notion / Gmail / Google Drive / Google Calendar / Slack / Discord plugin) を起動時にロードしない | `ChannelConfig.mcpProfile = "default"` |

理由: relay 経路では Discord への出力は supervisor が tmux pane の stdout を拾って `discord.js` で送るため、Discord plugin MCP の `reply` / `react` 等は不要。同様に Notion 等の HTTP MCP は relay 自体には関与しない。`--no-chrome` も大半の channel では使わないので default disable。

「lazy load」は Claude Code 公式に仕組みが存在しないため、本実装では「default disable + 必要な channel だけ opt-in」で代替する。設定変更の検証は `bash scripts/list-mcp-load-time.sh --quick` で前後比較できる。

## Headless executor モード (`DISPATCH_EXECUTOR_MODE`, Epic #285 Phase 2)

`/dispatch`（corp からの自動起動）で始まる部署セッションは、既定では tmux 内の対話 TUI（`tmux new-session -d` で `claude` を起動し、`waitForInputReady` で Ink TUI の描画を待って send-keys で初期コマンドを注入）で動く。この経路は RW-019（copy-mode で send-keys が silent drop）や RW-025/RW-047（TUI 表示文字列マッチのタイミング依存）といった手戻りクラスの温床になる。

dispatch は「Issue 番号とコマンドを与えて完走させる」バッチ的ワークロードで対話 TUI である必要がないため、**headless モード**を opt-in で用意している。headless では tmux も Ink TUI も使わず、`claude -p "<初期コマンド>"` を子プロセスとして spawn し、stdout を捕捉して部署スレッドへ投稿する。TUI 依存の故障モードが構造的に消える。

### 有効化（opt-in・逃げ道）

| env | 値 | 挙動 |
|---|---|---|
| `DISPATCH_EXECUTOR_MODE` | 未設定（既定） / `tmux` | 現行の tmux 対話 TUI 経路（変更なし） |
| `DISPATCH_EXECUTOR_MODE` | `headless` | dispatch を `claude -p` の子プロセスで実行し stdout をスレッド返却 |
| `DISPATCH_HEADLESS_TIMEOUT_MS` | 正の整数（既定 `18000000` = 5h、#388 で 2h から延長） | headless 子プロセスの wall-clock 上限。超過で SIGTERM → スレッドにタイムアウト明示。不正値（0 / 負 / 非数値）は既定へフォールバック |
| `DISPATCH_CLAUDE_MODEL` | 未設定（既定） | 設定時のみ headless argv に `--model <値>` を追加（例 `claude-opus-4-8`）。未設定・空白のみ = 環境既定モデル（現行不変）。corp #81 Phase 6 / #298 |

- 完全に **opt-in**: `headless` 以外の値（未設定・空・大文字 `HEADLESS` 等）はすべて `tmux` にフォールバックする（`resolveExecutorMode`、fail-safe）。
- `DISPATCH_CLAUDE_MODEL`: 不正なモデル ID はサイレント fallback せず、`claude -p` のローンチ失敗（非ゼロ exit）として既存経路でスレッドに明示される。`--model` は `claude --help`（v2.1.201）で実在確認済み。
- 対話セッション（`/session start`、primary channel）は headless 化しない。人間との対話は TUI のまま。
- Supervisor の plist `EnvironmentVariables` に `DISPATCH_EXECUTOR_MODE=headless` を追加 → `launchctl bootout`+`bootstrap` で反映（他の env 同様、`kickstart -k` では env 再読込されない点に注意）。

### 起動フラグ（TUI 専用フラグの除外）

headless の argv は `buildHeadlessClaudeFlags()`（`supervisor/src/session/manager.ts`）が生成する。tmux 経路の `buildClaudeFlags()` は bash コマンド文字列への埋め込み用に値を pre-quote しているため**再利用せず**、shell を通さない argv 配列として組み立てる（`--mcp-config '{...}'` の literal quote 混入を防ぐ）。TUI 表示名 `--name` は除外。`claude --help`（v2.1.201）で確認したフラグ: `-p`/`--print`、`--output-format text`、`--dangerously-skip-permissions`、`--no-chrome`、`--strict-mcp-config`、`--mcp-config`、`--session-id`。

### ライフサイクル / 誤回収防止

- 子プロセス spawn 時に session を登録（MAX_SESSIONS 枠・`/session list` に反映）、exit で close（DB を `stopped` 化、reason は `headless_exited` / タイムアウトは `headless_timeout`、worktree は best-effort 削除）。
- headless セッションは自己終了（子プロセス exit が権威的な liveness）で relay 進捗を出さないため、tmux idle 前提の **OrphanDispatchReaper / GoalWatcher は `executor:"headless"` を skip** する（idle 誤回収・done ラベル起因の stop() レースを回避）。wedge した子は上記 `DISPATCH_HEADLESS_TIMEOUT_MS` で回収する。既定を 5h に延ばした結果（#388）、wedge した子が MAX_SESSIONS 枠を占有し得る最大時間も 5h になる。枠飽和が起きる運用では `DISPATCH_HEADLESS_TIMEOUT_MS` を短く戻すか `DISPATCH_MAX_CONCURRENT` を下げて同時実行数側で調整する。

### 観測ログ

- 起動: `[SessionManager] Started <channel> headless (PID: ..., thread: ..., cmd: /impl <N>)`
- 終了: `[SessionManager] Headless session for thread <id> closed (reason: headless_exited|headless_timeout, exit: <code>)`
- bot 側: `[Bot] Headless dispatch completed in channel <ch> (thread=..., exit=..., timedOut=...)`
- 非ゼロ exit / タイムアウト / exit 0 だが stdout 空 は、いずれも**スレッドに明示投稿**する（サイレント成功にしない）。

### 実行レポートコメント（Issue #289 / corp #75 Phase 4）

headless 実行の完了時、対象 Issue へ実行レポートを `gh issue comment` で投稿する（部署 worktree cwd から実行）。これは **corp reconcile が parse する契約**（corp #76 が対向実装）で、見出しと `- key: value` 行の形を機械的に維持する:

```
## Dispatch 実行レポート

- tokens: <合計 output tokens／取得不能なら行ごと省略>
- duration_ms: <実行時間（wall-clock, ms）>
- exit_code: <claude -p の exit code／kill/timeout 時は null>
```

- tokens は `claude -p --output-format json` の `usage.output_tokens` から取得（実行検証済み・v2.1.201）。取得できない（JSON parse 失敗等）場合は **tokens 行を省略**し捏造しない。`0` は実値として出力する。
- 投稿失敗は **fail-soft**: `[SessionManager] Failed to post dispatch report ...` を warn ログに残し、セッション終端・実行結果は巻き込まない。
- headless モード時のみ。tmux 経路には投稿しない。
- 契約の単一 source: `supervisor/src/session/dispatch-report.ts`（`formatDispatchReport`）。

### 段階導入（WARN-first dogfood の写像）

1. `DISPATCH_EXECUTOR_MODE=headless` を opt-in で有効化し、agent-base 向け dispatch（no-template / pdca）で数日 dogfood。
2. 故障モードを観測ログで確認。問題なければ既定を headless に昇格し、tmux は明示指定の逃げ道として残す。

## 多セッション性能（Phase 5, Epic #292）

10+ セッション同時起動の重さ・timeout は **CPU 実行キュー飽和**が主犯（実測: 10 core に load 13-21、swap 0）。MAX_SESSIONS=10 は 11 本目を拒否するだけで 10 本同時 active の飽和を防げないため、以下の 3 施策を追加した。既定値はすべて安全側（現行挙動を壊さない）。

### 5b: 対話セッション idle reaper の短縮（#293）

| env | 既定 | 意味 |
|---|---|---|
| `SESSION_IDLE_TIMEOUT_MS` | `21600000`（6h） | 対話セッションの idle 自動終了しきい値。idle セッションは CPU/RAM を squat するため 30 日→6h に短縮 |

- 30 日は **hard backstop に降格**: 実効しきい値 = `min(SESSION_IDLE_TIMEOUT_MS, 30日)`。巨大値を設定しても 30 日で必ず回収する。
- `SESSION_IDLE_TIMEOUT_MS=2592000000`（30日）で**旧挙動を完全復元**できる。
- 停止時にスレッドへ **resume 導線**（`/session resume <id>` または `/session start <branch>`）を残す。
- dispatch 専用の `DISPATCH_ORPHAN_IDLE_MS`（48h, #275）とは別軸。二重実装せず、本 5b は汎用 Reaper のしきい値のみを可変化。

### 5c: dispatch 同時実行制限 + FIFO キュー（#294）

| env | 既定 | 意味 |
|---|---|---|
| `DISPATCH_MAX_CONCURRENT` | `5` | 同時に実行する dispatch セッションの上限。超過分は**拒否せずキュー**に積み、先行完了で FIFO 起動。既定は #389 で `3` → `5` に引き上げ（`MAX_SESSIONS = 10` の残り 5 枠は interactive 用）。負荷逼迫時はこの env で運用側から絞れる |

- 対話 `/session start` は**このキューを通らない**（`MAX_SESSIONS` のみで制限）。人間の体験は不変。
- キュー投入時・キューから起動時にスレッドへ状態を明示（サイレントに待たせない）。
- **再起動時のキュー扱い（選択理由）**: キューは **in-memory** で、supervisor 再起動で消える。永続化（DB + 再起動時 dedup）は不採用。理由: corp reconcile が未完了 Issue を再検出して re-dispatch するため、落ちたキュー項目は上流で self-heal する（既存の「再起動で in-flight relay 状態が消える」姿勢と同じ）。

### 5d: ResourceMonitor 連動の動的 admission（WARN-first, #295）

| env | 既定 | 意味 |
|---|---|---|
| `DISPATCH_ADMISSION_ENFORCE` | 未設定（= observe） | `1` で enforce（高負荷時に新規起動を遅延）。既定は**観測のみ**（WARN ログ、遅延なし） |

- **WARN-first**: 既定は observe モード = 高負荷（load > core 数）で WARN を出すが遅延しない。ResourceMonitor が定期サンプリングして高負荷エピソードをログ化する。
- enforce は **数日 observe して false positive ゼロを確認してから**有効化する（thin-scaffolding dogfood）。決して起動を拒否せず、遅延のみ（dispatch は落とさない）。
- **撤退基準（YAGNI）**: 5c の FIFO キューだけで timeout が解消するなら、本 5d の enforce は**有効化しない**。observe のログで「遅延が必要な高負荷が実際に発生しているか」を確認し、発生していなければ enforce へ昇格させず observe のまま（または撤去）とする。

### 5a: headless の有効化（運用のみ）

`DISPATCH_EXECUTOR_MODE=headless`（上記「Headless executor モード」節）を Supervisor 環境に設定して dogfood 開始。完了で自己終了するため常駐 TUI の squat が構造的に消え、5c/5d の効果と相乗する。

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

### 機械ゲート（#267 backstop）

access.json の `requireMention` と `scripts/hijoguchi-system-prompt.md` の沈黙ルールは「メッセージが LLM に届く／届いた後に LLM が沈黙を選ぶ」前提のため、いずれかが破れると claudeHubExit が非 primary で誤応答する（#230 の system-prompt ゲートが #267 で再破綻：Channel-Supervisor のセッションスレッドに届いた非メンション `/resume-session` に 👀 + 返信した）。

これを LLM 判断に依存しない形で塞ぐため、**PreToolUse の機械ゲート**を追加した（投稿の直前で決定的に DENY する）:

- `scripts/hijoguchi-record-channel-context.sh`（UserPromptSubmit）: 受信した Discord メッセージごとに「chat_id」と「自分宛メンション有無」を `${CLAUDE_HUB_STATE_DIR}/channel-ctx/<chat_id>` に記録する（記録のみ・常に exit 0）。
- `scripts/hijoguchi-discord-gate.sh`（PreToolUse: `reply`/`react`/`edit_message`）: 投稿先が **primary 以外** かつ **直近の受信が非メンション**なら **exit 2 で DENY**。primary は常時許可、非 primary はメンション時のみ許可（= 条件1/2 を機械化）。記録欠如は fail-closed で DENY。
- いずれも `CLAUDE_HUB_HIJOGUCHI_SESSION=1` の claudeHubExit セッションにのみ適用（`start-hijoguchi.sh` が `HIJOGUCHI_CHANNEL_ID` / `HIJOGUCHI_BOT_MENTION` を `env` 前置で in-session hook へ転送）。
- 仕様メモ: 非 primary では **本文に明示の mention タグ**を要求する（plugin の reply-implicit mention は本文に現れないため honor しない＝ #230 条件2 より厳格な fail-safe）。回帰テスト: `scripts/test-hijoguchi-discord-gate.sh`。

### 反映

access.json は毎メッセージ読み込まれるため、編集は即反映。Bot 再起動不要。

### 変更手順

1. `cp access.json access.json.bak.YYYYMMDD`（日付付きバックアップ）
2. `jq` で atomic write（`tmp` ファイル → `mv`）
3. `jq empty access.json` で schema 検証
4. 動作確認: 実メッセージで owner mention → 応答あり / 非 owner mention → 無応答

### `dispatchFrom`（/dispatch・/brief の外部トリガー許可）

`allowFrom`（人間の relay 許可）とは別に、group ごとの `dispatchFrom` が **bot 起点のメッセージコマンド**の送信元を許可する。対象は `/dispatch <branch> <N>`（`dispatch.ts`）と `/brief <YYYY-MM-DD>`（`corp-brief.ts`、#426 の朝レポ受け口）。判定は `isDispatchSourceAllowed`（`supervisor/src/config/access-policy.ts`）で **fail-closed** — group 未登録のチャンネルは常に拒否、group があっても送信元が `dispatchFrom` に無ければ拒否する。例外は env `DISPATCH_ALLOWED_SOURCE_IDS`（カンマ区切りのグローバル allowlist）に載っている送信元のみで、これは per-channel の `dispatchFrom` を補完するが「group が登録済みであること」のゲートは迂回できない。

必要な group（`examples/access-policy.template.json` の `dispatchFrom` 付きエントリと対応）:

| group | 用途 |
|---|---|
| 各部署チャンネル（team-salary / convert-service / agent-base） | corp dispatch bot からの `/dispatch`（corp `registry.yaml` の `dispatchChannelId` と対応） |
| corp | corp dispatch bot からの `/brief`（朝レポ配信を契機に #corp 直下へタップ決裁ボタンを post する。#426 / #445 / #449） |

新しいチャンネルへ `/dispatch` / `/brief` を通すときは、その group に corp dispatch bot の user id を `dispatchFrom` として追加する。**corp の entry を忘れると `/brief` が silent に denied になり朝レポの決裁 UI が出ない**（#445 の実事故）。

`/brief` は #449 以降セッションを介さない: supervisor が `ChannelConfig.brief`（`config/channels.ts`）の proposals CLI を実行して未決提案を取得し、チャンネル直下に承認/却下/保留ボタンを post する。**ボタンを押せる（= 決裁を確定できる）のは group の `allowFrom` に列挙されたユーザーのみ**（`brief-decision.ts`、ask-components と同じゲート）。`brief` 設定の無いチャンネルでは `/brief` は「実行設定がありません」で fail-closed になる。

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

## Required env vars (Supervisor — `/session compact` の primary channel routing, Issue #199 AC1)

claudeHubExit の primary channel（`#claude-hub-hijoguchi`）はスレッドではない通常チャンネルで、その長命セッションは **default tmux socket** の `claudeHubExit` session（`start-hijoguchi.sh` 管理、Supervisor の `-L claude-hub` socket とは別サーバ）。この channel で `/session compact` を実行したとき claudeHubExit を compact できるよう、**Supervisor 側にも** primary channel id を教える。

`~/Library/LaunchAgents/com.claude-hub.supervisor.plist` の `EnvironmentVariables` に以下を追加（値は hijoguchi plist の `HIJOGUCHI_CHANNEL_ID` と同じ。上記 §「Required env vars (claudeHubExit)」の `1487701062205964329`）:

```xml
<key>HIJOGUCHI_CHANNEL_ID</key>
<string>1487701062205964329</string>
```

反映（**`kickstart -k` ではなく `bootout`+`bootstrap`**）:

```bash
# kickstart -k はキャッシュされたサービス定義で再起動するだけで plist の
# env 変更を再読込しない。新規 env を反映するには bootout + bootstrap が必須。
launchctl bootout   gui/$(id -u)/com.claude-hub.supervisor
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-hub.supervisor.plist

# 確認: environment セクションに HIJOGUCHI_CHANNEL_ID が出ること
launchctl print gui/$(id -u)/com.claude-hub.supervisor | grep -A4 '	environment = {'
```

- **未設定（空文字）= 機能 OFF（fail-safe）**: primary channel で `/session compact` はスレッド用の usage hint を返すだけ。境界（Supervisor↔claudeHubExit の独立性）は明示 wiring するまで閉じたまま。
- スレッド内セッションの `/session compact`（Issue #200）は本 env に依存せず従来どおり動作する。

## 参考: 過去の事故

- Issue #21: Mac スリープ/復帰で Discord interaction token が失効 → unhandled rejection → Bun プロセスクラッシュ。PR #22 で `unhandledRejection`/`uncaughtException` handler + safe reply wrapper を追加して修正
- Issue #47: 非 primary group の `allowFrom` が空 → 非 owner の mention でも Bot が応答する状態を修正。owner ID を明示列挙
