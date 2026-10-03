#!/bin/bash
# PermissionRequest hook: 離席中のツール実行許可を iPhone から承認/拒否する (Issue #488)
#
# 対話セッション（supervisor 管理外）が許可待ちで止まると、Mac の前にいない間は誰も答えられない。
# Mac を一定時間操作していないときだけ、Pushover に「承認」「拒否」のワンタップリンクを送り、
# action receiver（Tailscale 限定, src/action/）が書く decision ファイルを待つ。
#
# 何も決めずに終わる（= Mac 上の通常の許可ダイアログに戻す）条件:
#   - supervisor セッション（SUPERVISOR_RELAY_URL あり。auto-approve-permission.sh が処理する）
#   - REMOTE_APPROVE=0 / 在席中 / 鍵・receiver URL 未設定 / 通知が上限・重複で送られなかった
#   - 待ち時間切れ / 待っている間にユーザーが Mac に戻ってきた
# 勝手に許可することは無い。
#
# 環境変数（テスト用の差し替え含む）:
#   REMOTE_APPROVE_AWAY_SEC   離席とみなす無操作秒数（既定 300）
#   REMOTE_APPROVE_WAIT_SEC   iPhone の回答を待つ秒数（既定 1800。settings.json の timeout はこれより長く）
#   REMOTE_APPROVE_IDLE_CMD   無操作秒数を出すコマンド（既定 ioreg の HIDIdleTime）
#   PERM_REQUEST_DIR          receiver と共有する待ちファイルの置き場所
#   AGENT_BASE_SCRIPTS        notify-once.sh / action-token.sh の場所（既定 ~/.claude/scripts）

[ -n "${SUPERVISOR_RELAY_URL:-}" ] && exit 0
[ "${REMOTE_APPROVE:-1}" = "0" ] && exit 0

AWAY_SEC="${REMOTE_APPROVE_AWAY_SEC:-300}"
WAIT_SEC="${REMOTE_APPROVE_WAIT_SEC:-1800}"
POLL_SEC="${REMOTE_APPROVE_POLL_SEC:-2}"
DIR="${PERM_REQUEST_DIR:-$HOME/.claude/state/perm-requests}"
SCRIPTS="${AGENT_BASE_SCRIPTS:-$HOME/.claude/scripts}"
LOG="${REMOTE_APPROVE_LOG:-$HOME/.claude/logs/remote-approve-permission.log}"

log() {
  mkdir -p "$(dirname "$LOG")"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"
}

idle_seconds() {
  if [ -n "${REMOTE_APPROVE_IDLE_CMD:-}" ]; then
    eval "$REMOTE_APPROVE_IDLE_CMD"
  else
    ioreg -c IOHIDSystem | awk '/HIDIdleTime/ { print int($NF / 1000000000); exit }'
  fi
}

IDLE=$(idle_seconds)
case "$IDLE" in ''|*[!0-9]*) log "skip: idle time unavailable"; exit 0 ;; esac
[ "$IDLE" -lt "$AWAY_SEC" ] && exit 0

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"')
DETAIL=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // .tool_input.file_path // .tool_input.url // "" ' | head -c 120)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""')

# shellcheck source=/dev/null
source "$SCRIPTS/lib/keychain-get.sh" 2>/dev/null || { log "skip: keychain-get.sh not found"; exit 0; }
RECEIVER_URL=$(keychain_get pushover-action-receiver-url 2>/dev/null || true)
[ -n "$RECEIVER_URL" ] || { log "skip: pushover-action-receiver-url not set"; exit 0; }

ID="req-$(openssl rand -hex 8)"
DENY_TOKEN=$(bash "$SCRIPTS/lib/action-token.sh" perm-deny "$ID" "$WAIT_SEC" 2>/dev/null) || {
  log "skip: token generation failed"; exit 0; }
case "$RECEIVER_URL" in *\?*) SEP="&" ;; *) SEP="?" ;; esac

mkdir -p "$DIR"
: > "$DIR/$ID.pending"
cleanup() { rm -f "$DIR/$ID.pending" "$DIR/$ID.decision"; }
trap cleanup EXIT

html_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
BODY="<b>$(printf '%s' "$TOOL" | html_escape)</b> の実行許可を待っています
$(printf '%s' "$DETAIL" | html_escape)
場所: $(printf '%s' "$CWD" | html_escape)

上のボタンで承認 / <a href=\"${RECEIVER_URL}${SEP}t=${DENY_TOKEN}\">🛑 拒否する</a>
（${WAIT_SEC} 秒で期限切れ。その後は Mac の確認画面に戻ります）"

# 承認リンクは pushover-notify の action_spec で url ボタンとして付く
NOTIFY_ONCE_REPORT=1 PUSHOVER_HTML=1 PUSHOVER_ACTION_TTL="$WAIT_SEC" bash "$SCRIPTS/lib/notify-once.sh" \
  "$ID" "perm-$ID" "許可待ち: ${TOOL}" "$BODY" 1 "$CWD" "perm-allow:${ID}"
RC=$?
if [ "$RC" -ne 0 ]; then
  log "skip: notification not sent (rc=${RC}) id=${ID} tool=${TOOL}"
  exit 0
fi
log "waiting id=${ID} tool=${TOOL} detail=${DETAIL}"

DEADLINE=$(( $(date +%s) + WAIT_SEC ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$DIR/$ID.decision" ]; then
    DECISION=$(cat "$DIR/$ID.decision")
    log "decided id=${ID} decision=${DECISION}"
    case "$DECISION" in
      allow)
        jq -n '{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "allow"}}}'
        exit 0 ;;
      deny)
        jq -n '{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "deny", message: "iPhone から拒否されました"}}}'
        exit 0 ;;
    esac
    log "ignored unknown decision id=${ID}"
    exit 0
  fi
  # ユーザーが Mac に戻ってきたら待つのをやめ、Mac の確認画面に任せる
  # 在席判定ができなくなったら、Mac に戻っていても気付けないので待つのをやめる
  NOW_IDLE=$(idle_seconds)
  case "$NOW_IDLE" in
    ''|*[!0-9]*) log "idle time unavailable while waiting id=${ID}"; exit 0 ;;
  esac
  if [ "$NOW_IDLE" -lt 30 ]; then log "back at Mac id=${ID}"; exit 0; fi
  sleep "$POLL_SEC"
done
log "timeout id=${ID}"
exit 0
