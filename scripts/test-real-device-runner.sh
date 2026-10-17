#!/bin/bash
# Tests the branching of scripts/real-device-runner.sh (Issue #507).
#
# The runner touches production (supervisor restart, GitHub statuses, Pushover),
# so every external effect is replaced by a recording stub after sourcing the
# script. git is real: a temp bare "origin" plus a clone on main stand in for
# ~/claude-hub, so the ff-only deploy path is exercised for real.
#
# Usage: bash scripts/test-real-device-runner.sh
set -uo pipefail

REPO_DIR_SRC="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

PASS=0
FAIL=0
assert() {
  local desc="$1"; shift
  if "$@"; then echo "PASS: $desc"; PASS=$((PASS + 1)); else echo "FAIL: $desc"; FAIL=$((FAIL + 1)); fi
}
count() { grep -c "$2" "$1" 2>/dev/null || true; }

git_q() { git -c user.email=t@example.com -c user.name=t "$@" >/dev/null 2>&1; }

# --- fixture: origin + production clone ---
setup() {
  rm -rf "$T/origin.git" "$T/prod" "$T/work" "$T/state" "$T/calls"
  git init -q --bare -b main "$T/origin.git"
  git clone -q "$T/origin.git" "$T/work" 2>/dev/null
  mkdir -p "$T/work/supervisor" && echo '{}' >"$T/work/supervisor/package.json"
  echo 1 >"$T/work/f" && git_q -C "$T/work" add f supervisor && git_q -C "$T/work" commit -m c1 && git_q -C "$T/work" push origin main
  git clone -q "$T/origin.git" "$T/prod"
  mkdir -p "$T/state"
  : >"$T/calls"
  RUNNING=0
  RUNNING_SEQ=""
  E2E_RC=0
  KICK_RC=0
  ISSUE_EXISTS=""
  ISSUE_CREATE_RC=0
  COMMENT_RC=0
}
push_commit() {
  echo "$1" >>"$T/work/f" && git_q -C "$T/work" commit -am "$1" && git_q -C "$T/work" push origin main
}

export RDR_REPO_DIR="$T/prod" RDR_STATE_DIR="$T/state" RDR_DEFER_ALERT_SEC=100
# shellcheck source=real-device-runner.sh
source "$REPO_DIR_SRC/scripts/real-device-runner.sh"
log() { :; }

# --- stubs (recorded to $T/calls) ---
post_status() { echo "status $1 $2 $3 $4" >>"$T/calls"; }
notify() { echo "notify $1 prio=${3:-1}" >>"$T/calls"; printf '%s\n' "$2" >"$T/last-notify-body"; }
# RUNNING_SEQ="0 1" なら 1 回目 0、2 回目以降 1（チェックと再起動の間に始まるセッションの再現）
running_session_count() {
  if [ -n "$RUNNING_SEQ" ]; then
    local n=$(( $(count "$T/calls" '^running') ))
    echo running >>"$T/calls"
    read -ra seq <<<"$RUNNING_SEQ"
    echo "${seq[$n]:-${seq[${#seq[@]}-1]}}"
  else
    echo "$RUNNING"
  fi
}
kickstart_supervisor() { echo "kickstart" >>"$T/calls"; return "$KICK_RC"; }
bun() { echo "bun $*" >>"$T/calls"; }
run_canary_e2e() {
  echo "e2e" >>"$T/calls"
  if [ "$E2E_RC" -eq 0 ]; then
    echo "合計: 6 PASS / 0 FAIL / 0 SKIP" >"$1"
  else
    printf '%s\n' "❌ [S2-4] error loop 停止 — 未検知: 同一署名 3 回" "合計: 5 PASS / 1 FAIL / 0 SKIP" >"$1"
  fi
  return "$E2E_RC"
}
gh() {
  echo "gh $*" >>"$T/calls"
  case "$1 $2" in
    "api search/issues"*) [ -n "$ISSUE_EXISTS" ] && echo "https://github.com/o/r/issues/$ISSUE_EXISTS" ;;
    "api repos/miyashita337/claude-hub/pulls?state=open&per_page=100") cat "$T/prs" 2>/dev/null ;;
    "api -X")
      case "$*" in
        *"/comments"*) return "$COMMENT_RC" ;;
        *"/issues "*) [ "$ISSUE_CREATE_RC" -eq 0 ] && echo "https://github.com/o/r/issues/999"; return "$ISSUE_CREATE_RC" ;;
      esac ;;
  esac
}
run_pr() { echo "run_pr $1 $2" >>"$T/calls"; }
pr_status_state() { cat "$T/prstatus-$1" 2>/dev/null; }

# 1. 新しい SHA + 稼働 0 件 → デプロイして canary success
setup
push_commit c2
target=$(git -C "$T/origin.git" rev-parse main)
canary
assert "1: ff-only でデプロイされる" test "$(git -C "$T/prod" rev-parse HEAD)" = "$target"
assert "1: supervisor を再起動する" test "$(count "$T/calls" '^kickstart')" -eq 1
assert "1: success status を投稿" grep -q "status $target success real-device/canary" "$T/calls"
assert "1: last-sha を記録" test "$(cat "$T/state/last-sha")" = "$target"
assert "1: PASS も音なしで通知（スマホで AC-1 を確かめられる）" grep -q "^notify claude-hub 実機 canary PASS.*prio=-1" "$T/calls"
assert "1: 通知にコミット件名" grep -q "^main ${target:0:8}: c2$" "$T/last-notify-body"
assert "1: 通知にコミットの URL" grep -q "^コミット: https://github.com/miyashita337/claude-hub/commit/$target$" "$T/last-notify-body"

# 2. 同じ SHA → 何もしない
: >"$T/calls"
canary
assert "2: 検証済み SHA では e2e も status も無し" test ! -s "$T/calls"

# 3. 稼働セッションあり → 延期（status は SHA ごとに 1 回、再起動しない）
setup
RUNNING=2
push_commit c3
target=$(git -C "$T/origin.git" rev-parse main)
canary
canary
assert "3: pending status は 1 回だけ" test "$(count "$T/calls" "status $target pending")" -eq 1
assert "3: 再起動しない" test "$(count "$T/calls" '^kickstart')" -eq 0
assert "3: デプロイしない" test "$(git -C "$T/prod" rev-parse HEAD)" != "$target"
assert "3: 延期理由に件数が入る" grep -q "稼働セッション 2 件" "$T/calls"

# 4. 延期が DEFER_ALERT_SEC を超えたら通知は 1 回だけ
echo "$target $(( $(date +%s) - 200 ))" >"$T/state/deferred"
canary
canary
assert "4: 長期延期の通知は 1 回" test "$(count "$T/calls" '^notify .*延期')" -eq 1

# 5. 稼働 0 件に戻れば延期分がデプロイされ deferred が消える
RUNNING=0
canary
assert "5: 延期後にデプロイされる" test "$(git -C "$T/prod" rev-parse HEAD)" = "$target"
assert "5: deferred 状態を消す" test ! -f "$T/state/deferred"

# 6. e2e FAIL → failure status + 通知 + Issue 起票（既存 Issue があれば起票しない）
setup
E2E_RC=1
push_commit c6
target=$(git -C "$T/origin.git" rev-parse main)
canary
assert "6: failure status" grep -q "status $target failure real-device/canary" "$T/calls"
assert "6: Pushover 通知" grep -q '^notify claude-hub 実機 canary FAIL' "$T/calls"
assert "6: 通知に落ちたシナリオと理由" grep -q '^\[S2-4\] error loop 停止 — 未検知' "$T/last-notify-body"
assert "6: 通知に Issue の URL" grep -q '^Issue: https://github.com/o/r/issues/999' "$T/last-notify-body"
assert "6: Issue を起票" test "$(count "$T/calls" '^gh api -X POST repos/[^ ]*/issues -f')" -eq 1
assert "6: 同じ SHA は再実行しない" test "$(cat "$T/state/last-sha")" = "$target"
setup
E2E_RC=1
ISSUE_EXISTS=123
push_commit c6b
canary
assert "6b: 同じ SHA の Issue があれば起票しない" test "$(count "$T/calls" '^gh api -X POST repos/[^ ]*/issues -f')" -eq 0

# 7. 本番ツリーに未コミット変更 → error で延期、触らない
setup
push_commit c7
echo dirty >>"$T/prod/f"
canary
assert "7: error status で延期" grep -q "real-device/canary 本番ツリーが main でないか未コミット変更あり" "$T/calls"
assert "7: 未コミット変更を残す" grep -q dirty "$T/prod/f"
assert "7: e2e を実行しない" test "$(count "$T/calls" '^e2e')" -eq 0

# 8. PR ハンドオフ: 判定済みの head は飛ばし、pending / 未投稿は実行（複数 PR を読み落とさない）
setup
printf '10 aaa\n11 bbb\n12 ccc\n' >"$T/prs"
echo success >"$T/prstatus-aaa"
echo pending >"$T/prstatus-bbb"
pr_handoff
assert "8: 判定済み head は飛ばす" test "$(count "$T/calls" '^run_pr 10')" -eq 0
assert "8: pending（ラベル付け直し等）は再実行" test "$(count "$T/calls" '^run_pr 11 bbb')" -eq 1
assert "8: status 未投稿も実行" test "$(count "$T/calls" '^run_pr 12 ccc')" -eq 1

# 8b. fork の PR と許可外の作者の PR はこの Mac で実行しない（実際の jq で filter を評価）
# REST /pulls の形（labels / head.repo / base.repo / user）
sel=$(jq -r "$(pr_select_jq)" <<'JSON'
[{"number":1,"head":{"sha":"a","repo":{"full_name":"o/r"}},"base":{"repo":{"full_name":"o/r"}},"user":{"login":"miyashita337"},"labels":[{"name":"real-device"}]},
 {"number":2,"head":{"sha":"b","repo":{"full_name":"fork/r"}},"base":{"repo":{"full_name":"o/r"}},"user":{"login":"miyashita337"},"labels":[{"name":"real-device"}]},
 {"number":3,"head":{"sha":"c","repo":{"full_name":"o/r"}},"base":{"repo":{"full_name":"o/r"}},"user":{"login":"someone-else"},"labels":[{"name":"real-device"}]},
 {"number":4,"head":{"sha":"d","repo":{"full_name":"o/r"}},"base":{"repo":{"full_name":"o/r"}},"user":{"login":"miyashita337"},"labels":[{"name":"bug"}]}]
JSON
)
assert "8b: real-device ラベル・同一リポ・許可作者の PR だけ選ぶ" test "$sel" = "1 a"

# 8c. 結果コメントの投稿に失敗したら次周期で再投稿（GraphQL レート制限で 0 件だった実測の回帰）
setup
echo "body" >"$T/body.md"
COMMENT_RC=1
post_pr_comment 20 abcdef12 success "$T/body.md" "$T/log" 2>/dev/null
assert "8c: 失敗したら再試行マーカーを残す" test -f "$T/state/comment-retry-20-abcdef12"
COMMENT_RC=0
: >"$T/prs"
pr_handoff
assert "8c: 次周期で再投稿してマーカーを消す" test ! -f "$T/state/comment-retry-20-abcdef12"

# 11. 再起動に失敗 → last-sha を書かず次周期で再デプロイ（ツリーは新 SHA でも再起動し直す）
setup
KICK_RC=1
push_commit c11
target=$(git -C "$T/origin.git" rev-parse main)
canary
assert "11: failure status" grep -q "status $target failure real-device/canary デプロイ失敗" "$T/calls"
assert "11: last-sha を書かない" test ! -f "$T/state/last-sha"
KICK_RC=0
: >"$T/calls"
canary
assert "11: 次周期で再起動し直す" test "$(count "$T/calls" '^kickstart')" -eq 1
assert "11: 再デプロイ後に canary success" grep -q "status $target success" "$T/calls"

# 12. 稼働チェック後〜再起動前にセッションが始まったら再起動しない
setup
RUNNING_SEQ="0 1"
push_commit c12
canary
assert "12: 再起動しない" test "$(count "$T/calls" '^kickstart')" -eq 0
assert "12: 延期 status" grep -q "pending real-device/canary 稼働セッション 1 件" "$T/calls"

# 13. 同じ SHA でも延期理由が変われば status を投稿し直す
setup
RUNNING=1
push_commit c13
target=$(git -C "$T/origin.git" rev-parse main)
canary
echo dirty >>"$T/prod/f"
canary
assert "13: 理由の変化で error を投稿" grep -q "status $target error real-device/canary" "$T/calls"

# 14. 失敗 Issue の起票に失敗したら次周期で再試行する
setup
E2E_RC=1
ISSUE_CREATE_RC=1
push_commit c14
canary
assert "14: 再試行マーカーを残す" test -f "$T/state/issue-retry"
ISSUE_CREATE_RC=0
: >"$T/calls"
canary
assert "14: 次周期で起票し直す" test "$(count "$T/calls" '^gh api -X POST repos/[^ ]*/issues -f')" -ge 1
assert "14: 成功したらマーカーを消す" test ! -f "$T/state/issue-retry"

# 9. disabled → 何もしない
setup
push_commit c9
touch "$T/state/disabled"
main
assert "9: disabled なら canary も PR も動かない" test "$(count "$T/calls" '^\(status\|gh\|e2e\)')" -eq 0

# 10. run_with_timeout: パイプの先が上限秒数まで待たされない（watchdog の sleep が
#     stdout を握って `| tee | grep` が EOF を待ち続けた実測バグの回帰）
t0=$(date +%s)
out=$(run_with_timeout 30 echo hi | cat)
assert "10: 速く終わるコマンドはパイプ越しでも即返る" test "$out" = hi -a $(( $(date +%s) - t0 )) -lt 5
t0=$(date +%s)
run_with_timeout 1 sleep 20
rc=$?
assert "10: 上限を超えたら打ち切る" test "$rc" -ne 0 -a $(( $(date +%s) - t0 )) -lt 5

# 15. 打ち切り時は孫プロセスも落とす（e2e-orchestrate 配下の bun / e2e-live が残らない）
run_with_timeout 1 bash -c 'sleep 23457 & wait' 2>/dev/null
# TERM 後に消えるまで最大 5 秒待つ（1 秒固定だと負荷時に取りこぼした実測あり）
left=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  left=$(ps -e -o command= | grep -c '^sleep 23457$' || true)
  [ "$left" -eq 0 ] && break
  sleep 0.5
done
assert "15: 孫プロセスが残らない" test "$left" -eq 0

echo
echo "結果: $PASS PASS / $FAIL FAIL"
[ "$FAIL" -eq 0 ]
