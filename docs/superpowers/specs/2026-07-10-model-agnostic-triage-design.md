# モデル非依存 Issue トリアージ基盤 設計

- 日付: 2026-07-10
- ステータス: 承認済み（壁打ちセッションで 4 論点を確定）
- 関連: #347（モデルルーティング backlog の先行具体例）/ ローカル定期オーケストレーター設計（段2 launchd poller の上流部品）

## 背景 / 目的

auto-ok ラベルのトリアージ（Open Issue を判定し、自動 /pdca 投入対象を選別する作業）は、現状 Fable 5 セッションへの手貼りプロンプトでのみ実行できる。Fable 5 の提供終了・トークン/レート制限で使えなくなった場合、トリアージが属人（属モデル）的に停止する。

本設計は、トリアージの振る舞い（判定基準＋手順）を **ファイル化された正本** に載せ、Opus 4.8 等の別モデルでも同一品質で実行できる仕組みを claude-hub 内に作る。

auto-ok は後段で自動 /pdca（実装→テスト→レビュー対応→squash merge）に直結するため、誤付与は低品質 PR の自動 merge 事故になる。判定原則は「迷ったら付けない」。

## 確定した設計判断

| 論点 | 決定 | 理由 |
|---|---|---|
| 起動形態 | **C: skill 正本 + headless wrapper** | 判定基準を 1 箇所に置き、手動 /triage と launchd 自動起動の両経路から同じ基準を使う |
| モデルフォールバック | **C: 自動フォールバック + 通知** | 優先順リストで自動切替。発生時は Pushover 通知（サイレントフォールバック禁止準拠） |
| 品質同等性の担保 | **A: ゴールデンセット回帰** | 2026-07-10 の 52 件判定を正解データ化し、モデル切替時に dry-run 一致率を機械計測 |
| 置き場所 | **A: 全部 claude-hub** | 利用者が現状 claude-hub のみ。YAGNI に従い、他リポで必要になってから汎用化 |
| 判定と適用の分離 | **2 段構成**（モデル=判定 JSON のみ / ラベル適用=決定的スクリプト） | blast radius 縮小・dry-run と本番の差を apply 有無だけにする・golden-check が JSON 比較で済む |

## 全体像

```
手動:   /triage (セッション内 skill)  ──┐
                                        ├─→ SKILL.md（判定基準の正本）─→ 判定JSON ─→ apply（gh issue edit）
自動:   scripts/triage-issues.sh ───────┘         │
        （モデル優先リスト + フォールバック + 通知）  └─ dry-run 時は JSON 出力のみ（ラベル操作なし）
```

## コンポーネント

### 1. `.claude/skills/issue-triage/SKILL.md`（判定基準の正本）

2026-07-10 に実地使用したトリアージプロンプトを規範化する。内容:

- 前提（auto-ok の意味と誤付与リスク、「迷ったら付けない」原則）
- 除外条件: epic / investigation / in-progress / P1 ラベル、Epic・調査・設計・意思決定・backlog 系タイトル/本文、スコープ曖昧、再現手順の無いバグ、大改修、外部サービス・本番影響、既に auto-ok あり、対応 Open PR あり
- 付与条件（すべて満たす）: スコープ明確で自己完結、仕様の意思決定不要、バグなら再現/期待挙動明確、想定変更が小さい
- 出力: 判定 JSON（下記スキーマ）＋人間向け判定表
- Issue へのコメントは行わない（read + ラベル操作のみ、ラベル操作も apply 側の責務）
- モデル名に依存する記述を置かない（どのモデルで実行しても同一手順）

### 2. 判定 JSON スキーマ

```json
{
  "generated_at": "2026-07-10T19:00:00+09:00",
  "model": "claude-fable-5",
  "repo": "miyashita337/claude-hub",
  "judgments": [
    { "issue": 308, "verdict": "auto-ok", "reason": "テストDB分離の不備。再現証拠・期待挙動明確" },
    { "issue": 341, "verdict": "hold",    "reason": "#335 と同根因の重複。統合判断が先" },
    { "issue": 351, "verdict": "exclude", "reason": "案段階の多コンポーネント機構。設計要" }
  ]
}
```

verdict は `auto-ok` / `exclude` / `hold` の 3 値。`hold`（保留 = borderline）は人間判断に回す。

### 3. `scripts/triage-issues.sh`（headless wrapper）

- モデル優先リスト: env `TRIAGE_MODELS`（カンマ区切り、デフォルト `claude-fable-5,claude-opus-4-8`）
- 上位モデルから `claude -p` で skill 手順を実行し判定 JSON を取得。失敗（非ゼロ exit）なら次モデルへフォールバックし、Pushover + terminal-notifier で「モデル X 不可、Y で実行」を通知
- 全モデル失敗: Pushover CRITICAL + 非ゼロ exit（launchd 側で観測可能）
- `--dry-run`: 判定 JSON 出力のみ。ラベル操作なし
- 本番時: 判定 JSON の `auto-ok` 判定を wrapper 内の決定的な apply 処理（`gh issue edit <N> --add-label auto-ok`）で適用。冪等（既に付いていればスキップ）
- 実行ログ: `logs/triage/YYYY-MM-DD.jsonl` に「いつ・どのモデル・何を判定・apply したか・フォールバック有無」を追記

### 4. `tests/golden/triage-golden-set.json`（ゴールデンセット）

2026-07-10 の 52 件判定（auto-ok 6 / 除外 39 / 保留 7）を正解データ化する。**Issue のスナップショット（number / title / labels / body）を同梱**し、Issue が close されても再現可能な hermetic データにする:

```json
{
  "snapshot_date": "2026-07-10",
  "source_model": "claude-fable-5",
  "issues": [
    { "number": 308, "title": "...", "labels": ["bug"], "body": "...",
      "expected": "auto-ok", "reason": "テストDB分離の不備..." }
  ]
}
```

### 5. `scripts/triage-golden-check.sh`（一致率計測）

- golden set のスナップショットを入力として dry-run 判定を実行し、期待判定と比較
- **合格条件（両方必須）**:
  1. 誤爆 0 件: 正解が `exclude` / `hold` のものに `auto-ok` を付けていない（事故直結のため厳格）
  2. 全体一致率 ≥ 90%
- 不合格なら exit 1 = そのモデルでの自動投入を止める（基準を締める or 手動運用に落とす判断へ）
- 用途: モデル切替時の受け入れ検査。定期実行は必須にしない（YAGNI、必要になってから）

## エラー処理

- フォールバック発生は必ず通知 + ログ（agent-output-quality #1 サイレントフォールバック禁止）
- 判定 JSON がスキーマ不正（パース不能・verdict 不正値）の場合はそのモデルの実行を失敗扱いにし、次モデルへフォールバック
- apply は判定 JSON に列挙された Issue 番号のみを対象とし、モデル出力の他のテキストを解釈しない

## テスト

- golden-check 自体がモデル判定の回帰テスト
- wrapper のフォールバック/通知/apply 冪等性は、`claude` コマンドをモック（固定 JSON を返すスタブ）した bash テストで検証（既存 `tests/` 慣例に従う）

## スコープ外

- launchd poller 本体（ローカル定期オーケストレーター設計・段2の仕事。本設計は wrapper までを部品として提供）
- 他リポへの汎用化（agent-base 移設は 2 リポ目の実需が出てから）
- golden set の自動鮮度管理（スナップショット同梱で当面不要）

## Epic 分解

| Sub | 内容 | 依存 |
|---|---|---|
| 1 | SKILL 正本化: プロンプト → `issue-triage/SKILL.md` + 判定 JSON スキーマ定義 | なし |
| 2 | ゴールデンセット: 52 件スナップショット + 正解 + `triage-golden-check.sh` | Sub 1（スキーマ） |
| 3 | headless wrapper: フォールバック + 通知 + apply 分離 + `--dry-run` + 実行ログ | Sub 1 |
