#!/usr/bin/env bash
# real-device-runner.sh — CI（ubuntu）で測れない実機 E2E を Mac 上で自動実行する（Issue #507）。
#
#   bash scripts/real-device-runner.sh            # launchd から 15 分ごとに起動される
#   bash scripts/real-device-runner.sh --once-pr N # PR N だけ即時に実行（手動デバッグ）
#
# 2 段構成:
#   A. post-merge canary — origin/main が前回検証 SHA から進んでいたら、稼働セッションが
#      0 件のときだけ ff-only で取り込み supervisor を再起動（= デプロイ）し、実 Discord を含む
#      決定的シナリオを e2e-orchestrate.sh で実行する。結果は commit status
#      `real-device/canary`、FAIL 時は Pushover + Issue 自動起票（SHA 単位で 1 件）。
#      稼働セッションがあるときは止めずに延期する（#351 の教訓: 勝手に止めない）。
#   B. PR ハンドオフ — `real-device` ラベル付き open PR の head を一時 worktree に取り出し、
#      hermetic 回帰 + 隔離スタック（e2e-isolated.ts の s2-4 / s2-5）を macOS 上で実行する。
#      結果は commit status `real-device/pr` + PR コメント。live Discord は本番 supervisor の
#      再起動が要るため A（merge 後）に任せる。
#
# 停止: touch ~/.local/state/real-device-runner/disabled
# ログ: ~/claude-hub/logs/real-device-runner.log（plist の StandardOutPath）と
#       ~/.local/state/real-device-runner/runs/<種別>-<sha>.log（実行ごとの全出力）
# 手順・前提: docs/real-device-runner.md
set -uo pipefail

REPO_DIR="${RDR_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
GH_REPO_SLUG="${RDR_GH_REPO:-miyashita337/claude-hub}"
STATE_DIR="${RDR_STATE_DIR:-$HOME/.local/state/real-device-runner}"
SUPERVISOR_LABEL="${RDR_SUPERVISOR_LABEL:-com.claude-hub.supervisor}"
NOTIFY_SCRIPT="${RDR_NOTIFY_SCRIPT:-$HOME/.claude/scripts/pushover-notify.sh}"
PR_LABEL="${RDR_PR_LABEL:-real-device}"
# PR の段はこの Mac で PR のコードを実行する。同一リポかつこの作者の PR だけを対象にする
PR_AUTHORS="${RDR_PR_AUTHORS:-miyashita337}"
# モデルの判断に依存して結果が揺れる s1 / s2-3 は含めない（flaky な canary は信頼されなくなる）。
# s2-2 は s2-3 で起動したオーケストレーターが前提のため、s2-3 なしでは常に SKIP になる（実測）
CANARY_SCENARIOS="${RDR_CANARY_SCENARIOS:-s1b,s2-1,s2-4,s2-5,s3}"
# supervisor 再起動後、relay port ファイルが書かれるまでの待ち
BOOT_WAIT_SEC="${RDR_BOOT_WAIT_SEC:-30}"
# 稼働セッションのせいでこの秒数以上デプロイできていなければ 1 回だけ通知する
DEFER_ALERT_SEC="${RDR_DEFER_ALERT_SEC:-86400}"
# 1 回の E2E 実行の上限（e2e-live の S2-3 は 8 分待つので余裕を持たせる）
RUN_TIMEOUT_SEC="${RDR_RUN_TIMEOUT_SEC:-2700}"
# bun install の上限（固まるとロックを握ったまま以降の周期がすべてスキップされる）
INSTALL_TIMEOUT_SEC="${RDR_INSTALL_TIMEOUT_SEC:-600}"

CANARY_CONTEXT="real-device/canary"
PR_CONTEXT="real-device/pr"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"; }

# ---------- 外部とのやり取り（テストでは差し替える） ----------

post_status() { # sha state context description → 投稿できなければ 1
  gh api -X POST "repos/$GH_REPO_SLUG/statuses/$1" \
    -f state="$2" -f context="$3" -f description="${4:0:140}" >/dev/null && return 0
  log "WARN: commit status 投稿に失敗 ($3 $2 ${1:0:8})"
  return 1
}

notify() { # title message [priority]
  # RDR_NOTIFY_PREFIX: 手動の確認実行で「[テスト]」等を付け、本番の通知と見分けられるようにする
  local title="${RDR_NOTIFY_PREFIX:-}$1"
  if [ -x "$NOTIFY_SCRIPT" ] || [ -f "$NOTIFY_SCRIPT" ]; then
    bash "$NOTIFY_SCRIPT" "$title" "$2" "${3:-1}" || log "WARN: Pushover 通知に失敗: $title"
  else
    log "WARN: 通知スクリプトが無い ($NOTIFY_SCRIPT): $1 — $2"
  fi
}

running_session_count() {
  local out
  if ! out=$(cd "$REPO_DIR" && bun run supervisor/tools/session-ctl.ts list 2>&1); then
    log "ERROR: session-ctl list が失敗: $out"
    return 1
  fi
  # セッション行（id=…）だけを数える。末尾の集計行「計 N 件 (status=running)」は含めない
  printf '%s\n' "$out" | grep -c '^id=.*status=running' || true
}

kickstart_supervisor() {
  launchctl kickstart -k "gui/$(id -u)/$SUPERVISOR_LABEL" && sleep "$BOOT_WAIT_SEC"
}

# 子プロセスを上限秒数で打ち切る（macOS 標準に timeout(1) が無いため自前）
run_with_timeout() { # secs cmd...
  local secs="$1"; shift
  # 子を別プロセスグループで起動し、打ち切り時は孫（bun test / e2e-live / tmux 起動）ごと落とす
  set -m
  "$@" &
  local pid=$!
  set +m
  # 標準出力をパイプから切り離す（sleep がパイプを握ったままだと、呼び出し側の
  # `| tee | grep` が上限秒数まで EOF を待ち続ける）。TERM で sleep も道連れにする
  ( trap 'kill "$s" 2>/dev/null; exit 0' TERM
    sleep "$secs" & s=$!
    wait "$s" && kill -TERM -- "-$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid"
  local rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return "$rc"
}

bun_install() { # dir
  (cd "$1" && bun install --frozen-lockfile)
}

run_canary_e2e() { # logfile
  run_with_timeout "$RUN_TIMEOUT_SEC" \
    bash "$REPO_DIR/scripts/e2e-orchestrate.sh" --scenario "$CANARY_SCENARIOS" >"$1" 2>&1
}

# 同じ SHA の失敗 Issue は 1 件だけ（15 分ごとの再実行で増やさない。RW-075 の型）。
# 起票済み・新規いずれも URL を $STATE_DIR/issue-url-<short> に残し、通知本文に載せる。
# gh issue list / create は GraphQL でレート制限を他ツールと共有するため REST を使う
open_failure_issue() { # sha logfile
  local sha="$1" short="${1:0:8}" body url
  # 検索の失敗を「該当なし」と扱うと、一時的な API 障害だけで同じ SHA の Issue が重複する
  if ! url=$(gh api "search/issues?q=repo:$GH_REPO_SLUG+in:title+%22real-device+canary+$short%22" \
    -q '.items[0].html_url // ""'); then
    log "WARN: 既存 Issue の検索に失敗"
    return 1
  fi
  if [ -n "$url" ]; then
    log "既存の失敗 Issue あり ($url)。起票しない"
    echo "$url" >"$STATE_DIR/issue-url-$short"
    return 0
  fi
  body="$STATE_DIR/issue-$short.md"
  # リポジトリは public。ログ本文（チャンネル ID・パス等）は載せず、判定行と FAIL 行の見出しだけ
  {
    echo "main の \`$sha\` で実機 canary（scripts/real-device-runner.sh）が FAIL しました。"
    echo
    echo "- 判定: $(summary_line "$2")"
    # live の行だけ理由（— 以降）を落とす。bun test のテスト名は — を含むことがある
    failed_lines "$2" | sed -E '/^\[/s/ — .*$//; s/^/- /' | head -n 20
    echo
    echo "全ログ: 実行した Mac の \`${2/#$HOME/~}\`"
  } >"$body"
  url=$(gh api -X POST "repos/$GH_REPO_SLUG/issues" -f title="bug: real-device canary $short が FAIL" \
    -F "body=@$body" -f 'labels[]=bug' -q .html_url 2>/dev/null) \
    || url=$(gh api -X POST "repos/$GH_REPO_SLUG/issues" -f title="bug: real-device canary $short が FAIL" \
      -F "body=@$body" -q .html_url) || return 1
  echo "$url" >"$STATE_DIR/issue-url-$short"
}

# 通知本文。スマホの通知だけで「何が・どこで・次に何を見るか」が分かるようにする
canary_message() { # sha description logfile
  local subject
  subject=$(git -C "$REPO_DIR" log -1 --format=%s "$1" 2>/dev/null)
  echo "main ${1:0:8}: ${subject:-(件名不明)}"
  echo "判定: $2"
  if [ -n "$3" ] && [ -f "$3" ]; then
    failed_lines "$3" | cut -c1-120 | head -n 5
  fi
  [ -f "$STATE_DIR/issue-url-${1:0:8}" ] && echo "Issue: $(cat "$STATE_DIR/issue-url-${1:0:8}")"
  echo "コミット: https://github.com/$GH_REPO_SLUG/commit/$1"
}

summary_line() { # logfile → 「N PASS / M FAIL / K SKIP」行。live の集計まで届かなければ止まった段
  local s stage nfail
  s=$(grep -E '^合計: ' "$1" | tail -n 1 | sed 's/^合計: //')
  if [ -z "$s" ]; then
    # 前段の bun test（hermetic 回帰）で落ちると「合計:」行が出ず、判定が空になっていた（#523）
    stage=$(grep -E '^== \[[0-9]+/[0-9]+\] ' "$1" | tail -n 1 | sed -E 's/^== //; s/ ==$//')
    nfail=$(grep -E '^ *[0-9]+ fail$' "$1" | tail -n 1 | tr -dc '0-9')
    s="${stage:-判定行なし（ログ参照）}${stage:+で停止}${nfail:+（bun test ${nfail} fail）}"
  fi
  echo "$s"
}

failed_lines() { # logfile → 落ちたシナリオ（live）か、無ければ落ちたテスト名（bun test）。重複は除く
  if grep -qE '^❌ \[' "$1"; then
    grep -E '^❌ \[' "$1" | sed -E 's/^❌ //'
  else
    # bun test は末尾で (fail) 行を再掲するので重複を落とす
    grep -E '^\(fail\) ' "$1" | sed -E 's/ \[[0-9.]+ms\]$//' | awk '!seen[$0]++'
  fi
}

# ---------- A. post-merge canary ----------

canary() {
  # 前回 FAIL の Issue 起票に失敗していれば先に再試行する（失敗が Issue 化されずに消えないように）
  if [ -f "$STATE_DIR/issue-retry" ]; then
    local rsha rlog
    read -r rsha rlog <"$STATE_DIR/issue-retry"
    open_failure_issue "$rsha" "$rlog" && rm -f "$STATE_DIR/issue-retry"
  fi
  # 前回の最終 status を投稿できていなければ再投稿する（E2E はやり直さない）
  if [ -f "$STATE_DIR/status-retry" ]; then
    local ssha sstate sdesc
    { read -r ssha sstate; read -r sdesc; } <"$STATE_DIR/status-retry"
    # 再投稿もできないなら今回は進めない（次の SHA の結果でマーカーを上書きして前回分を失わないように）
    if ! post_status "$ssha" "$sstate" "$CANARY_CONTEXT" "$sdesc"; then
      log "canary: ${ssha:0:8} の status を再投稿できないため今回は見送り"
      return 0
    fi
    rm -f "$STATE_DIR/status-retry"
  fi
  git -C "$REPO_DIR" fetch -q origin main || { log "ERROR: git fetch 失敗"; return 1; }
  local target last
  target=$(git -C "$REPO_DIR" rev-parse origin/main)
  last=$(cat "$STATE_DIR/last-sha" 2>/dev/null || true)
  if [ "$target" = "$last" ]; then
    log "canary: ${target:0:8} は検証済み"
    return 0
  fi

  # 本番の作業ツリーが想定外の状態なら触らない（手作業中の変更を壊さない）
  local branch
  branch=$(git -C "$REPO_DIR" symbolic-ref --short HEAD 2>/dev/null || echo "(detached)")
  if [ "$branch" != "main" ] || ! git -C "$REPO_DIR" diff --quiet HEAD; then
    defer "$target" "error" "本番ツリーが main でないか未コミット変更あり（branch=${branch}）"
    return 0
  fi

  local running
  running=$(running_session_count) || { defer "$target" "error" "session-ctl list が失敗"; return 0; }
  if [ "$running" -gt 0 ]; then
    defer "$target" "pending" "稼働セッション ${running} 件のためデプロイ延期"
    return 0
  fi

  local before
  before=$(git -C "$REPO_DIR" rev-parse HEAD)
  # supervisor が target のコードで動いているかは「最後に再起動できた SHA」で判断する。
  # ツリーだけ新しい（デプロイ途中の失敗・手動の git pull・初回導入）なら旧コードが動いている
  if [ "$(cat "$STATE_DIR/deployed-sha" 2>/dev/null)" != "$target" ] || [ "$before" != "$target" ]; then
    if [ "$before" != "$target" ] && ! git -C "$REPO_DIR" merge -q --ff-only origin/main; then
      defer "$target" "error" "ff-only merge 失敗（本番ツリーが main から分岐）"
      return 0
    fi
    # 取り込み済みのツリーを再起動し直すときは、前回の install が済んだか分からないので必ず入れる
    if [ "$before" = "$target" ] || ! git -C "$REPO_DIR" diff --quiet "$before" "$target" -- supervisor/bun.lock supervisor/package.json; then
      run_with_timeout "$INSTALL_TIMEOUT_SEC" bun_install "$REPO_DIR/supervisor" \
        || { deploy_failed "$target" "bun install 失敗"; return 0; }
    fi
    # fetch / merge / install の間に始まったセッションを巻き込まない
    running=$(running_session_count) || { deploy_failed "$target" "session-ctl list が失敗"; return 0; }
    if [ "$running" -gt 0 ]; then
      defer "$target" "pending" "稼働セッション ${running} 件のためデプロイ延期"
      return 0
    fi
    log "canary: ${before:0:8} → ${target:0:8} をデプロイ（supervisor 再起動）"
    kickstart_supervisor || { deploy_failed "$target" "supervisor の再起動に失敗"; return 0; }
    echo "$target" >"$STATE_DIR/deployed-sha"
  fi

  post_status "$target" pending "$CANARY_CONTEXT" "実機 E2E 実行中 ($CANARY_SCENARIOS)"
  mkdir -p "$STATE_DIR/runs"
  local logf="$STATE_DIR/runs/canary-${target:0:8}.log"
  if run_canary_e2e "$logf"; then
    finish_canary "$target" success "PASS: $(summary_line "$logf")" "$logf"
  else
    finish_canary "$target" failure "FAIL: $(summary_line "$logf")" "$logf"
  fi
}

finish_canary() { # sha state description logfile
  if ! post_status "$1" "$2" "$CANARY_CONTEXT" "$3"; then
    printf '%s %s\n%s\n' "$1" "$2" "$3" >"$STATE_DIR/status-retry"
  fi
  if [ "$2" = "failure" ]; then
    # 起票を先に行い、通知に Issue の URL を載せる
    if [ -n "$4" ] && ! open_failure_issue "$1" "$4"; then
      log "WARN: 失敗 Issue の起票に失敗。次回再試行"
      echo "$1 $4" >"$STATE_DIR/issue-retry"
    fi
    notify "claude-hub 実機 canary FAIL（main ${1:0:8}）" "$(canary_message "$1" "$3" "$4")"
  else
    # 成功もスマホで確かめられるよう、音なし（-1）で知らせる
    notify "claude-hub 実機 canary PASS（main ${1:0:8}）" "$(canary_message "$1" "$3" "$4")" -1
  fi
  echo "$1" >"$STATE_DIR/last-sha"
  rm -f "$STATE_DIR/deferred"
  log "canary: ${1:0:8} $2 — $3"
}

# デプロイ失敗: last-sha も deployed-sha も書かず次周期でやり直す。status と通知は SHA・理由ごとに 1 回
deploy_failed() { # sha reason
  defer "$1" "failure" "デプロイ失敗: $2"
}

# 延期・デプロイ失敗の記録。status は (SHA, 状態, 理由) が変わったときだけ投稿し、
# 同じ SHA の延期が DEFER_ALERT_SEC を超えたら 1 回だけ通知する（SHA が変われば数え直す）
defer() { # sha state reason
  local sha="$1" key="$2 $3" psha="" since="" notified="" pkey=""
  if [ -f "$STATE_DIR/deferred" ]; then
    { read -r psha since notified; read -r pkey; } <"$STATE_DIR/deferred"
  fi
  if [ "$psha" != "$sha" ]; then since=$(date +%s); notified=""; fi
  if [ "$psha" != "$sha" ] || [ "$pkey" != "$key" ]; then
    post_status "$sha" "$2" "$CANARY_CONTEXT" "$3"
    [ "$2" = "failure" ] && notify "claude-hub 実機 canary: デプロイ失敗" "${sha:0:8}: $3"
  fi
  if [ -z "$notified" ] && [ $(( $(date +%s) - since )) -ge "$DEFER_ALERT_SEC" ]; then
    notify "claude-hub 実機 canary 延期が続いています" "$3。main ${sha:0:8} が実機で未検証です"
    notified=1
  fi
  printf '%s %s %s\n%s\n' "$sha" "$since" "$notified" "$key" >"$STATE_DIR/deferred"
  log "canary: ${sha:0:8} 延期 — $3"
}

# ---------- B. PR ハンドオフ ----------

# gh の呼び出しは REST（gh api）に限る。gh pr list / gh pr comment は GraphQL を使い、
# auto-land など同じアカウントの他ツールと枠を共有してレート制限に当たる（#507 の実測）
pr_handoff() {
  retry_pr_comments
  local lines
  lines=$(gh api "repos/$GH_REPO_SLUG/pulls?state=open&per_page=100" -q "$(pr_select_jq)") \
    || { log "ERROR: PR 一覧の取得に失敗"; return 1; }
  local n sha
  # fd 3 で読む（ループ内の gh / bun が標準入力を食べると後続 PR が読み落とされる）
  while read -r n sha <&3; do
    [ -z "$n" ] && continue
    # 判定済み（success / failure / error）の head は飛ばす。pending や未投稿なら（ラベルの
    # 付け直し・reopen で workflow が pending に戻した場合も含め）実行する
    case "$(pr_status_state "$sha")" in
      success|failure|error) continue ;;
    esac
    run_pr "$n" "$sha"
  done 3<<<"$lines"
}

run_pr() { # number sha
  local n="$1" sha="$2" short="${2:0:8}"
  log "pr: #$n ${short} を実行"
  post_status "$sha" pending "$PR_CONTEXT" "実機ランナー実行中"
  mkdir -p "$STATE_DIR/runs"
  local logf="$STATE_DIR/runs/pr-$n-$short.log" table="$STATE_DIR/runs/pr-$n-$short.md"
  local ok=1
  : >"$table"
  if run_pr_suites "$n" "$sha" "$logf" "$table"; then ok=0; fi
  local state=failure desc
  [ "$ok" -eq 0 ] && state=success
  desc="$( [ "$state" = success ] && echo PASS || echo FAIL ) (hermetic + s2-4/s2-5 on macOS)"
  post_status "$sha" "$state" "$PR_CONTEXT" "$desc"
  post_pr_comment "$n" "$sha" "$state" "$table" "$logf"
}

# fork の PR と許可外の作者の PR は対象外（この Mac で他人のコードを実行しない）
pr_select_jq() {
  printf ' .[] | select(any(.labels[]; .name == "%s"))' "$PR_LABEL"
  printf '%s' ' | select(.head.repo.full_name == .base.repo.full_name)'
  printf ' | select(.user.login as $a | "%s" | split(",") | index($a))' "$PR_AUTHORS"
  printf '%s' ' | "\(.number) \(.head.sha)"'
}

pr_status_state() { # sha → real-device/pr の最新 state（無ければ空）
  gh api "repos/$GH_REPO_SLUG/commits/$1/statuses" \
    -q "[.[] | select(.context == \"$PR_CONTEXT\")][0].state // \"\"" 2>/dev/null
}

post_pr_comment() { # number sha state table logfile
  local body="$STATE_DIR/runs/pr-$1-${2:0:8}.comment.md"
  {
    echo "### 実機ランナー（macOS）: $( [ "$3" = success ] && echo '✅ PASS' || echo '❌ FAIL' )"
    echo
    echo "対象: \`$2\` / 実行: \`scripts/real-device-runner.sh\`（Issue #507）"
    echo
    echo "| 段 | 判定 | 実測 |"
    echo "|---|---|---|"
    cat "$4"
    echo
    echo "live Discord（s1b / s2-1 / s3）は merge 後の canary（\`$CANARY_CONTEXT\`）で実行されます。"
    echo "全ログ: \`${5/#$HOME/~}\`（実行した Mac 上）"
  } >"$body"
  if ! gh api -X POST "repos/$GH_REPO_SLUG/issues/$1/comments" -F "body=@$body" >/dev/null; then
    log "WARN: PR コメント投稿に失敗 (#$1)。次回再試行"
    echo "$1 $body" >"$STATE_DIR/comment-retry-$1-${2:0:8}"
  fi
}

# 投稿に失敗した結果コメントを再投稿する（status は success でも PR に結果表が無い状態を残さない）
retry_pr_comments() {
  local f n body
  for f in "$STATE_DIR"/comment-retry-*; do
    [ -f "$f" ] || continue
    read -r n body <"$f"
    if gh api -X POST "repos/$GH_REPO_SLUG/issues/$n/comments" -F "body=@$body" >/dev/null; then
      rm -f "$f"
      log "pr: #$n の結果コメントを再投稿"
    fi
  done
}

run_pr_suites() { # number sha logfile table → 全段 PASS で 0
  local n="$1" sha="$2" logf="$3" table="$4" wt="$STATE_DIR/pr-worktree" rc=0
  git -C "$REPO_DIR" worktree remove --force "$wt" 2>/dev/null
  if ! { git -C "$REPO_DIR" fetch -q origin "pull/$n/head" \
      && git -C "$REPO_DIR" worktree add -q --detach "$wt" "$sha"; } >>"$logf" 2>&1; then
    echo "| 準備 | FAIL | PR head の取り出しに失敗 |" >>"$table"
    return 1
  fi
  if ! run_with_timeout "$INSTALL_TIMEOUT_SEC" bun_install "$wt/supervisor" >>"$logf" 2>&1; then
    echo "| 準備 | FAIL | bun install 失敗 |" >>"$table"
    rc=1
  else
    if run_with_timeout "$RUN_TIMEOUT_SEC" bash "$wt/scripts/e2e-orchestrate.sh" --skip-live >>"$logf" 2>&1; then
      echo "| hermetic 回帰（CI と同じ e2e + session ユニット） | PASS | macOS 実 tmux |" >>"$table"
    else
      echo "| hermetic 回帰（CI と同じ e2e + session ユニット） | FAIL | ログ末尾参照 |" >>"$table"
      rc=1
    fi
    run_isolated "$wt" s2-4 claude-error-loop-mock.sh "$logf" "$table" || rc=1
    run_isolated "$wt" s2-5 claude-mock.sh "$logf" "$table" || rc=1
  fi
  git -C "$REPO_DIR" worktree remove --force "$wt" >>"$logf" 2>&1
  return "$rc"
}

# e2e-live.ts の runIsolatedScenario と同じ隔離 env で e2e-isolated.ts を直接起動する
# （e2e-live 経由だと live のプリフライトが必須になり、PR の段では回せないため）
run_isolated() { # worktree scenario fixture logfile table
  local wt="$1" s="$2" scratch line
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/rdr-$s-XXXXXX")
  line=$(cd "$wt" && run_with_timeout "$RUN_TIMEOUT_SEC" env \
    SUPERVISOR_TMUX_SOCKET="claude-hub-rdr-$s" \
    SUPERVISOR_DB_PATH="$scratch/sessions.db" \
    XDG_RUNTIME_DIR="$scratch/runtime" \
    SUPERVISOR_CLAUDE_PATH="$wt/supervisor/tests/e2e/fixtures/$3" \
    bun supervisor/tools/e2e-isolated.ts --scenario "$s" 2>>"$4" | tee -a "$4" | grep '^E2E_ISOLATED_RESULT:' | tail -n 1)
  rm -rf "$scratch"
  if [ -n "$line" ] && printf '%s' "${line#E2E_ISOLATED_RESULT:}" | jq -e '.ok == true' >/dev/null 2>&1; then
    echo "| ${s}（隔離スタック） | PASS | ok=true |" >>"$5"
    return 0
  fi
  local why
  why=$(printf '%s' "${line#E2E_ISOLATED_RESULT:}" | jq -r '.failures | join("; ")' 2>/dev/null)
  echo "| ${s}（隔離スタック） | FAIL | ${why:-結果行なし} |" >>"$5"
  return 1
}

# ---------- エントリポイント ----------

main() {
  mkdir -p "$STATE_DIR"
  if [ -f "$STATE_DIR/disabled" ]; then
    log "disabled ($STATE_DIR/disabled)。何もしない"
    return 0
  fi
  # 二重起動防止（前回が長引いている間に launchd が次を起動しても重ならない）
  if ! mkdir "$STATE_DIR/lock" 2>/dev/null; then
    local holder
    holder=$(cat "$STATE_DIR/lock/pid" 2>/dev/null)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      log "前回の実行 (pid $holder) が継続中。スキップ"
      return 0
    fi
    log "残っていたロック (pid ${holder:-?}) を回収"
    rm -rf "$STATE_DIR/lock" && mkdir "$STATE_DIR/lock" || return 1
  fi
  echo $$ >"$STATE_DIR/lock/pid"
  trap 'rm -rf "$STATE_DIR/lock"' EXIT

  if [ "${1:-}" = "--once-pr" ] && [ -n "${2:-}" ]; then
    run_pr "$2" "$(gh api "repos/$GH_REPO_SLUG/pulls/$2" -q .head.sha)"
    return 0
  fi
  canary
  pr_handoff
}

# exit を同じ複合コマンド内に置く。canary の ff-only merge がこのファイル自体を書き換えても、
# bash は if…fi を読み終えてから実行するので、書き換わった後半を読み進めない
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
  exit $?
fi
