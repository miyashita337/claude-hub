---
date: 2026-05-03
status: rejected
decision_makers: AgentTeams（architect / devils-advocate / fact-checker）
related_issue: https://github.com/miyashita337/claude-hub/issues/105
parent_epic: https://github.com/miyashita337/claude-hub/issues/101
---

# ADR-001: Session pre-warming (warm pool) アーキテクチャの設計判断

## Status

**Rejected**（提案された warm pool 方式は技術的に成立しない）

代替として **案 Z: Always-On Sessions（全 channel 常時起動）** を follow-up Issue で検討する。

## Context

親 Epic #101「Claude session cold start time を 30s 以下に短縮」のサブ施策として、Issue #105 で「事前に warm な claude プロセスを 1〜2 個 standby させ、`/session start` 時にそれを thread に紐付ける」方式（pre-warming / warm pool）が提案された。期待短縮量 20-30s、工数=大、ADR 起票必須。

提案された具体的 mechanism:

1. supervisor 起動時に「どの project にも属さない warm な claude プロセス」を `SUPERVISOR_WARM_POOL=N` 個 standby
2. `/session start` 受信時、warm pool から 1 個 pop → thread (= cwd + channel name) に紐付け
3. pop 後に async で 1 個補充

### 既存実装の核心

`supervisor/src/session/manager.ts` の `SessionManager.start()` は以下を行う:

1. tmux session 作成（`-L claude-hub` socket、user `.tmux.conf` 隔離）
2. `SUPERVISOR_RELAY_URL` を runtime-dir ファイルに書き出し（project cwd ごと）
3. `cd "${config.dir}" && exec claude --dangerously-skip-permissions --name "${config.channelName}"` を tmux 内で起動
4. iTerm2 tab を非同期 open

claude プロセスは起動時 `cwd` と `--name <channel>` で project context が確定する。

## Decision

**Warm pool 方式（unbound プロセスを後から thread に紐付ける）は採用しない。**

理由は以下 3 点（fact-checker による公式仕様裏取り済）:

1. **POSIX cwd は exec 後に外部から変更できない**
2. **環境変数（`SUPERVISOR_RELAY_URL` 等）は exec 時点で確定し、外部上書き不可**
3. **`~/.claude/projects/<key>/` のキーは cwd ベース**で、`/rename` で変えられるのは表示名のみ

これらは warm pool の「pop 時に project に紐付ける」という根幹を否定する。

代替として **案 Z: Always-On Sessions** を follow-up Issue で検討する。Z 案は既存アーキテクチャをほぼ変えずに同等の cold start 削減を実現する。

## Rationale

### 公式仕様の裏取り（fact-checker 検証結果）

| # | 主張 | 結果 | 確度 | 根拠 |
|---|------|------|------|------|
| 1 | POSIX `chdir(2)` は自プロセスのみ変更、tmux send-keys で子プロセスの cwd は変わらない | TRUE | 高 | [chdir(2) Linux man page](https://man7.org/linux/man-pages/man2/chdir.2.html)、tmux send-keys は pane の foreground process（shell）への入力のみ。`exec claude` 後の claude プロセスには shell が存在しない |
| 2 | `--name` は起動時引数のみ、後付け rebind 不可 | 部分 FALSE | 高 | [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) で `/rename` による mid-session 名変更は可能。**ただし `~/.claude/projects/<key>/` のキーは cwd ベース**であり表示名変更は project 切り替えにならない |
| 3 | 環境変数は exec 時点で固定、外部上書き不可 | TRUE | 高 | [proc_pid_environ(5) Linux man page](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html)、`/proc/<pid>/environ` は execve(2) 時点の値で読み取り専用。macOS は SIP で ptrace 経由メモリ書換も制限 |
| 4 | SessionStart hook は起動時 1 回のみ | FALSE | 高 | [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)、SessionStart hook は resume 時に `source: "resume"` 付きで再実行。`CwdChanged` イベントも存在 |

主張 4 は朗報だが、**主張 1 と 3 が warm pool の前提を完全否定する**ため、hook 再実行が可能でも warm pool 方式自体は成立しない。

### 技術的不成立の本質

warm pool 方式は「warm プロセスは project 未確定の状態で起動 → pop 時に project を bind」を前提とするが:

- **cwd を後から変えられない** → `~/.claude/projects/` のキーが warm 起動時の cwd（例: `$HOME`）に固定される。pop 後に正しい project 配下で動作させる手段がない
- **`SUPERVISOR_RELAY_URL` を後から注入できない** → relay URL は project cwd でハッシュ化されるため、warm 時に未設定 → pop 時に設定が必要だが exec 後の env 上書きは不可
- **`/rename` は表示名のみ** → project 切り替えにはならない

これらを回避するには **pop 時に exec し直す = 結局 cold start** となり、warm pool の存在意義が消える。

### ROI 評価（devils-advocate）

仮に技術的成立性を無視しても、ROI は完全マイナス:

- **節約見込み**: cold start 30s × 想定起動頻度 1-2 件/週（個人開発、1 user）= 30-60s/週
- **コスト**: claude プロセス常駐 ~200MB × N pool size × 24h × 7 日 = N × 33.6 GB·h/週
- **比率**: N=2 で 67.2 GB·h/週 vs 60s/週 = 約 4000 倍の不釣り合い
- **副作用**: MAX_SESSIONS=10 の 20-30% を warm が占有 → 実 session 起動枯渇リスク

## Alternatives Considered

### 案 Y: Optimistic Ack Reply（**部分採用候補**）

**概要**: `/session start` 受信時に即座に「起動中... 30s お待ちください」を Discord に reply。実体は変えず体感のみ改善。

| 観点 | 評価 |
|------|------|
| 工数 | 30 分（`commands/session.ts` の `handleStart` に reply 1 行追加） |
| 効果 | 体感 cold start 0s（実 wall time は不変） |
| リスク | 低（既存 flow に追加のみ） |
| ROI | 極大 |

**判定**: cold start を実時間で短縮する施策ではないが、Epic #101 の「30s 以下」目標が「体感 30s 以下」を含むなら最有力。Epic 側で目標再定義が必要。

### 案 Z: Always-On Sessions（**推奨**）

**概要**: 全 11 channel の session を supervisor 起動時に自動 start し、idle でも kill しない。`/session start` は実質 no-op（既に running なら ack のみ）。

| 観点 | 評価 |
|------|------|
| 工数 | 中（MAX_SESSIONS 拡張、IDLE_TIMEOUT 無効化、起動時 auto-start ロジック追加） |
| 効果 | cold start 完全 0s（pre-bound、cwd/name 確定済） |
| RAM コスト | 11 channel × ~200MB = 2.2GB（warm pool 案と同程度） |
| 既存設計改修範囲 | `supervisor/src/config/channels.ts`（`MAX_SESSIONS` 11 へ）、`SessionManager`（auto-start メソッド追加）、`Reaper`（idle kill 無効化 flag） |
| リスク | 中（resource-monitor.ts の RAM 圧迫時挙動の検証必須、MAX_MEMORY_PER_SESSION_MB との整合） |

**判定**: warm pool が抱える cwd/env 制約を**全て回避**しつつ、warm pool と同等の cold start 削減を実現。**最有力**。follow-up Issue で詳細設計。

### 案 W: `/resume` ベースの保存セッション復元

**概要**: 各 channel ごとに事前に `/save-session` で empty session を保存 → `/session start` 時に `claude --resume <name>` で warm 復元。

| 観点 | 評価 |
|------|------|
| 効果 | 不明（resume 自体の wall time が cold start より短い保証なし） |
| 実装難度 | 高（save-session の自動化、resume 時の transcript 引継ぎ問題） |
| リスク | 高（Claude Code の `/resume` 仕様詳細は未調査） |

**判定**: 案 Z が成立するなら不要。検証コスト > 期待リターン。

### 案 X: Bun runtime preload

**概要**: claude プロセスの cold start のうち Bun runtime init / `.claude` 設定読込を pre-load で短縮。

**判定**: Bun 内部実装変更が要る + claude binary は Bun ランタイム同梱で外部介入不可 → 非現実的。**棄却**。

## Consequences

### 採用しない warm pool による影響

- Epic #101 の 30-60s cold start 問題は解消しない
- ただし**架空の解決策**を実装するより、技術的に成立する代替（案 Y / Z）に投資する方が正解
- Issue #105 は close（「warm pool 方式は技術的不成立、ADR-001 に決定根拠記録、案 Z で別 Issue 起票」のコメント付き）

### 案 Z 採用時の影響（follow-up Issue で検討）

- **+**: cold start 完全消滅、既存設計とほぼ整合、追加の race / hook 問題なし
- **−**: 11 session 常駐で ~2.2GB RAM 常時占有、resource-monitor.ts の閾値再設計が必要
- **要検討事項**:
  - `MAX_SESSIONS` を 11 以上に拡張（11 channel 全カバー + claude-hub guard 維持）
  - `IDLE_TIMEOUT_MS` を「auto-start session は無効化」フラグで分岐
  - supervisor 起動時の auto-start を直列か並列か（並列なら起動時 spike 発生）
  - 起動失敗時の retry / backoff
  - `/session stop` で kill した後の re-spawn 規約

### 必要な follow-up Issue

1. **新規 Issue（Epic #101 配下）**: 案 Z「Always-On Sessions」設計と実装
   - 親 Epic は #101
   - AC: `/session start` の 95th percentile が 5s 以下
   - 工数: 中
2. **新規 Issue（任意）**: 案 Y「Optimistic Ack Reply」を低コスト先行投入
   - 親 Epic は #101
   - 案 Z 完了までの暫定策として有用

## References

- Issue #105: https://github.com/miyashita337/claude-hub/issues/105
- Parent Epic #101: https://github.com/miyashita337/claude-hub/issues/101
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- POSIX chdir(2): https://man7.org/linux/man-pages/man2/chdir.2.html
- proc_pid_environ(5): https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html
- 関連既存実装: `supervisor/src/session/manager.ts`, `supervisor/src/config/channels.ts`, `supervisor/src/session/tmux.ts`
- 運用ルール: `docs/bot-operations.md`
