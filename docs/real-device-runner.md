# 実機ランナー（Issue #507）

CI（ubuntu）では実 Discord・launchd・macOS 固有の環境差（PATH、`lsof` など）を検証できない。
`scripts/real-device-runner.sh` は、この Mac 上で既存の E2E 部品（`scripts/e2e-orchestrate.sh`、
`supervisor/tools/e2e-isolated.ts`）を 15 分ごとに自動実行し、結果を GitHub の commit status で返す。

## 2 つの段

| 段 | いつ | 何をする | 結果 |
|---|---|---|---|
| A. merge 後 canary | `origin/main` が前回検証した SHA から進んだとき | 稼働セッションが 0 件なら `~/claude-hub` を ff-only で更新し supervisor を再起動（= デプロイ）。続けて決定的なシナリオ `s1b,s2-1,s2-2,s2-4,s2-5,s3` を実 Discord で実行 | `real-device/canary` status。FAIL 時は Pushover + Issue（`bug: real-device canary <sha> が FAIL`、SHA ごとに 1 件） |
| B. PR の引き継ぎ | open PR に `real-device` ラベルがあり、head が未実行のとき | PR head を一時 worktree に取り出し、hermetic 回帰（`e2e-orchestrate.sh --skip-live`）と隔離スタック s2-4 / s2-5 を macOS 上で実行 | `real-device/pr` status + PR コメント（結果表） |

- **稼働セッションがあるときはデプロイしない。** status を `pending`（延期）にして次回に回す。24 時間延期が続いたら 1 回だけ Pushover で知らせる。セッションを止めるかは人が決める
- 本番ツリー（`~/claude-hub`）が main 以外のブランチ、または追跡ファイルに未コミット変更があるときも触らない（status `error`）
- 再起動の直前にもう一度稼働セッションを数える（取り込み中に始まったセッションを巻き込まない）
- `bun install` や再起動に失敗したら status `failure` + Pushover。検証済みとは記録せず、次の周期でデプロイからやり直す
- リポジトリは public なので、失敗 Issue には判定行と FAIL したシナリオ名だけを載せる。ログ本文はこの Mac の `runs/` にだけ残す
- 1 回の実行は 45 分で打ち切り、配下のプロセス（bun / e2e-live / tmux 起動）ごと止める
- モデルの判断で結果が揺れる s1 / s2-3 は canary に入れない。必要なら手動で `bash scripts/e2e-orchestrate.sh` を回す
- PR の段で live Discord を回さないのは、本番 supervisor を PR のコードで再起動する必要があるため。live は merge 後の canary が担う

## いつ `real-device` ラベルを付けるか

CI で再現できない層に触る PR（Discord のメッセージ処理、tmux 中継、セッションのライフサイクル、launchd・PATH 依存のスクリプト）。
ラベルを付けると `.github/workflows/real-device-handoff.yml` がすぐに `real-device/pr` を pending にするので、
auto-land は結果が出るまで merge しない（pending は WAITING、failure は CI_FAILED として扱われる）。

ランナーは PR のコードをこの Mac で実行するので、対象を **同一リポジトリのブランチから出た、許可した作者の PR**（`RDR_PR_AUTHORS`、既定 `miyashita337`）に限る。fork の PR は対象外。
PR の段は `--skip-live` で動き、`supervisor/.env`（本番の Bot 設定）を PR のコードへ渡さない。

再実行の判定は GitHub 上の `real-device/pr` の状態で行う。success / failure / error が付いた head は飛ばし、pending か未投稿なら実行する
（push・reopen・ラベルの付け直しで workflow が pending に戻すと、次の周期で回り直す）。

## インストール

```bash
sed "s|/Users/YOUR_USER|$HOME|g" com.claude-hub.real-device-runner.plist \
  > ~/Library/LaunchAgents/com.claude-hub.real-device-runner.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-hub.real-device-runner.plist
```

前提は `docs/e2e-orchestrate.md` の「前提（手動準備・初回のみ）」と同じ（driver Bot token、corp の `allowFrom`、orchestrate-runner スキル）。

## 運用

| やりたいこと | 方法 |
|---|---|
| 止める | `touch ~/.local/state/real-device-runner/disabled` |
| 1 PR だけ今すぐ回す | `bash scripts/real-device-runner.sh --once-pr <N>`（作者・fork の制限を通らない。自分で中身を確認した PR だけに使う） |
| 同じ SHA の canary をやり直す | `rm ~/.local/state/real-device-runner/last-sha` |
| 動いているか見る | `~/claude-hub/logs/real-device-runner.log`（実行ごとの全出力は `~/.local/state/real-device-runner/runs/`） |

## 撤退基準

導入 1 か月後に、canary・PR の段のどちらも「merge 前後に不具合を検知した」実例が 0 件で、延期だけが続いているなら、
延期の原因（常時稼働セッション）を見直すか、ランナーを撤去する。
