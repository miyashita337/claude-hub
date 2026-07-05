# hook fan-out 削減レポート（Issue #310）

日付: 2026-07-06 / 親: #302（TUI 描画とは別軸の hook spawn 負荷）

## 計測手段

`scripts/measure-hook-fanout.py` — 全 hook ソース（`~/.claude/settings.json`・
installed_plugins.json が指す ECC plugin hooks.json・project settings.json）を parse し、
matcher 適用後の per-call spawn 数を決定的に算出。`--time` で各 hook を合成 payload
（`cwd` は throwaway /tmp dir → supervisor relay hook は早期 exit）で実行し median ms を計測。

注意: ms は**逐次合計**（Claude Code は hook を並列実行するため latency ではなく CPU 総量の proxy）。

## 結果（before → after）

| tool | spawns | 逐次合計 ms |
|---|---|---|
| Bash | 19 → **8**（-58%） | 3,899 → 2,016（-48%） |
| Edit | 16 → **7**（-56%） | 10,717 → 2,189（-80%） |
| Read | 4 → **1**（-75%） | 179 → 119 |
| UserPromptSubmit（per prompt） | 14 → **12** | — |

raw JSON: 計測時の `/tmp/hook-fanout-baseline.json` / `/tmp/hook-fanout-after.json`（値は本表と Issue #310 コメントに転記済み）。

## 削減内容（計 35 登録）

### `~/.claude/settings.json`（22 件、backup: `~/.claude/backups/settings.json.20260706-010649.issue310.bak`）

| 分類 | 件数 | 内容 | 根拠 |
|---|---|---|---|
| 死んだ登録 | 17 | `log-*.sh` 全系 + `compact-intent-check.sh` + `log-skill-invocation.sh` | スクリプト実体が `~/.claude/hooks/` に不存在（spawn→即失敗のみ）。agent-base repo 側でも削除済み＝上流削除後の stale 登録 |
| 重複 | 2 | `reset-retry-circuit [.*]` / `handle-retry-circuit [.*]` | narrow matcher 版（`Bash\|Edit\|Write\|mcp__claude-in-chrome__.*`）が併存し、agent-base 上流は narrow 版のみ登録。`.*` 版削除で上流と収束 |
| 上流削除済み orphan | 3 | `enforce-pr-issue-link` / `enforce-sub-issue`（Pre[Bash]）、`check-broken-symlinks`（Post[Write\|Edit]、**3.2s/edit**） | agent-base repo に実体なし（上流で削除済み）。ローカルの残置ファイル+登録のみ |

### ECC plugin hooks.json（13 件、backup: `~/.claude/backups/ecc-hooks.json.20260706-010649.issue310.bak`）

対象: `~/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.8.0/hooks/hooks.json`
（installed_plugins.json が 1.8.0 を pin。plugin 更新時は再適用が必要 — 下記 follow-up）

| 分類 | 内容 | 根拠 |
|---|---|---|
| body 無効化済みで spawn だけ残存 | `observe.sh`（Pre[*]/Post[*]）、`session-start.js` | `ECC_DISABLED_HOOKS=session:start,pre:observe,post:observe` で body skip 済み。登録削除で spawn 自体を除去（#310 本文の run-with-flags.js:88-100 検証どおり） |
| reminder 系 | `pre-bash-tmux-reminder` / `pre-bash-git-push-reminder` / `doc-file-warning` / `suggest-compact` / `auto-tmux-dev` | stderr へ注意書きを出すのみ or 未使用機能。push 系は agent-base の BLOCKING `check-direct-push-policy.sh` が、compact 系は `context-budget-check.sh` が上位互換 |
| stderr ログのみ | `post-bash-pr-created` / `post-bash-build-complete` | 実装確認済み: `console.error` 1 行のみで機能なし |
| agent-base と重複 | `post-edit-format`（auto-format.sh と重複）/ `post-edit-typecheck`（CI・/verify が担当、871ms/edit）/ `post-edit-console-warn`（quality-gate.js が console 検査を包含） | validation-layers.md の責務分担に整合 |

### KEEP（全数維持を回帰で確認）

block-dangerous / check-direct-push-policy / check-gh-account-match / check-lockfile-consistency /
check-rm-aliased-target / save-work-state / protect-config / mcp-pretool-block /
journey-ac-check / repro-evidence-check / context-budget-check / check-file-loss-claim /
work-blocker-check / rw-context-inject / inject-work-context / progress-relay / stop-relay /
reset-retry-circuit（narrow）/ handle-retry-circuit（narrow）/ classify-* / handle-*-failure /
auto-format / ECC insaits-security-wrapper / ECC quality-gate / ECC Stop 系（per-turn のため対象外）

## 回帰確認（T5）

- 安全 hook 登録の全数チェック: **26/26 PASS**（スクリプトで settings.json を機械検査）
- `block-dangerous.sh` 機能テスト: force-push main payload → **exit 2 BLOCK** / safe → exit 0
  （かつ本セッション内の実ツール呼び出しでも発火を実地確認）
- agent-base `tests/run-all.sh`: **52 PASS / 1 FAIL / 6 SKIP**
  - FAIL は `test_check_stale_assets.sh` のみ。同スクリプトは agent-base repo 資産の git 履歴を
    スキャンするもので、今回変更したファイル（`~/.claude/settings.json`・ECC hooks.json）への
    参照ゼロ＝**本変更と無関係**（agent-base 側 follow-up 候補）

## go/no-go 判定: **GO**

spawn 数 -56〜-75%・機能欠落なし（安全 hook 全数維持 + BLOCK 動作実証）。

## 多セッション load（統合ジャーニーAC #3、参考値）

環境依存の参考値。#292/#302 計測時は load 26.7 / 10 cores（5 セッション並列 + observe 有効時代）。
適用後の単発観測: load 6.20（1 分平均、セッション 1 本 + 通常負荷）。同条件 5 セッション並列での
再計測は #302 の継続観測に委ねる（本 issue の主 AC は per-call spawn 数の削減で達成済み）。

## follow-up

1. **agent-base**: `~/.claude/settings.json` がテンプレ配布後に手元で drift する構造の恒久対策
   （上流で hook を削除しても手元登録が残る = 今回の死んだ登録 17 件の発生機構）。
   併せて repo-only の新 hook（check-dispatch-base-freshness / check-article-close-gate /
   check-mycontext-staleness）が手元に未インストールである点も install 経路で解消する
2. **agent-base**: `save-work-state.sh`（〜0.5-2.5s/edit）と `block-dangerous.sh`（〜0.5s/bash）の
   内部最適化（登録削減ではなく実行時間の削減。本 issue の非目標）
3. **ECC plugin 更新時**: hooks.json が cache 再展開で復元されるため、本レポートの削減リストを
   再適用する（`scripts/measure-hook-fanout.py` で fan-out が戻っていないか検知可能）
4. **agent-base**: `test_check_stale_assets.sh` の FAIL（本変更と無関係、既存）
