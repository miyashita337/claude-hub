# claude-hub レビュー観点（Bugbot）

Discord から Claude Code セッションを起動・監督する supervisor。壊れると
**セッション・tmux・worktree が取り残されて枠が埋まる**、**認可を迂回して任意の入力が
Claude に注入される**といった事故になる。以下を最優先で見ること。

## 出力ルール

- コメントは**日本語**で書く。
- 各指摘に **`must` / `should` / `nit`** を明記する。`must` はマージをブロックする欠陥に限る。
- typo・整形のみの nit は省略する。
- `.claude/worktrees/**` は作業用 worktree なのでレビュー対象外。

## must として扱う観点

### 1. 注入経路に caller text を通さない
Discord 発の caller text は、**検証済みであっても** Claude セッションへ連結・テンプレート展開して
はならない。注入してよいのは supervisor 側が組み立てた固定リテラルと、supervisor 側で
**再生成**して固定形式の allowlist（例: `YYYY-MM-DD`）を通した値だけ。
caller text をサニタイズして通す、という設計に変える PR は must。

### 2. 認可の迂回
`evaluateAccess`（access.json の `allowFrom`）が唯一の門。新しい入口（新コマンド・新イベント・
スレッド自動起動など）を足すときに、この門を通していない経路は must。
「bot が作ったスレッドだから安全」という理由で門を省略しないこと。

### 3. セッション lifecycle の取り残し
起動・停止・reap の各経路で、以下を取り残していないか。

- tmux セッション / 子プロセス
- git worktree（作りっぱなし）
- `sessions.db` の行（実体が無いのに running のまま）

失敗パス・例外パスでも後片付けが走るか（early return で cleanup を飛ばしていないか）を見る。

### 4. 並列上限とキューの不変条件
`MAX_SESSIONS` などの上限チェックを緩める・スキップする変更は must。
枠が満杯のときに「無言で落ちる」のも禁止で、理由を post して可視化すること。

### 5. 生エラーの user-facing 転送
`err.message` / stack をそのまま Discord へ post する経路は情報漏洩になりうる。
サニタイズを通しているか（`safeReplyError` 等）。パス・トークン・内部 URL が出ていないか。

### 6. サイレントフォールバック
`catch {}`、失敗を握りつぶして正常系に見せる、通知せず exit 0。
失敗は必ずログ + `notifyPushover` 等の可視化経路に出す。

### 7. 機密
Discord bot token・API キーのハードコード、ログ・post への混入。

## should として扱う観点

- TypeScript: `any` の使用、外部入力（Discord payload / GitHub API / ファイル）の
  ランタイムバリデーション欠落
- 同一 projectDir で複数セッションを起こす変更（relay-url が衝突し応答が別スレッドへ流入する既知問題）
- tmux セッション名 / ブランチ名の衝突可能性
- Discord ゲートウェイ無しで単体テストできる形になっているか（純関数を `session/*.ts` に切り出す既存パターン）
- 新規ロジックにテストが無い（`cd supervisor && bun test`）
- kill-switch を新機能ごとに分ける（既存の停止フラグに相乗りして巻き込み停止させない）
