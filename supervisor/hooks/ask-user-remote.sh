#!/bin/bash
# PreToolUse[AskUserQuestion]: supervisor 外のセッションの質問を iPhone で答える (Issue #519)
#
# ask-user-relay.sh が「supervisor セッションではない」と判定したときに、入力 JSON を stdin で渡して呼ぶ。
# tmux で起動した /pdca の子などは、AskUserQuestion で止まると Mac の前にいない限り誰も答えられない。
# 離席中だけ、質問文と番号付きの選択肢を Pushover に載せ、回答ページ（action receiver, src/action/ask.ts）
# へのリンクを 1 本付ける。回答ページが書く <id>.answer を待ち、
#   permissionDecision: "allow" + updatedInput.answers
# で返すと、選択 UI を出さずに回答済みとしてツールが実行される
# （出典: code.claude.com/docs/en/hooks「AskUserQuestion and ExitPlanMode need updatedInput paired with "allow"」）。
#
# 何も返さずに終わる（= 通常の選択 UI に戻す）条件:
#   - AGENT_BASE_SESSION_RELAY=1 が無い（opt-in。オーケストレーターが子の起動時に渡す）
#   - REMOTE_APPROVE=0 / 在席中 / 受信 URL・鍵が無い / 通知が上限・重複で送られなかった
#   - 待ち時間切れ / 待っている間にユーザーが Mac に戻ってきた
# 勝手に答えることは無い。
#
# 待ち時間（既定 1800 秒）は settings.json の AskUserQuestion hook の timeout（21660 秒。不足は
# src/infra/hook-wiring-check.ts が起動時に警告）より短いこと。先に hook が殺されると回答が宙に浮く。
#
# 環境変数は remote-approve-permission.sh と共通（REMOTE_APPROVE_AWAY_SEC / _WAIT_SEC / _IDLE_CMD /
# _POLL_SEC / _LOG, PERM_REQUEST_DIR, AGENT_BASE_SCRIPTS）。

[ "${AGENT_BASE_SESSION_RELAY:-0}" = "1" ] || exit 0
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

INPUT=$(cat)

IDLE=$(idle_seconds)
case "$IDLE" in ''|*[!0-9]*) log "skip: idle time unavailable tool=AskUserQuestion"; exit 0 ;; esac
if [ "$IDLE" -lt "$AWAY_SEC" ]; then
  log "skip: at Mac (idle=${IDLE}s < ${AWAY_SEC}s) tool=AskUserQuestion"; exit 0
fi

QUESTIONS=$(printf '%s' "$INPUT" | jq -c '.tool_input.questions // [] | select(type == "array" and length > 0)' 2>/dev/null)
[ -n "$QUESTIONS" ] || { log "skip: AskUserQuestion without questions"; exit 0; }
# answers は質問文をキーにするため、同じ文の質問が 2 つあると片方の答えが消える。TUI に任せる
if ! printf '%s' "$QUESTIONS" | jq -e '(map(.question) | unique | length) == length' >/dev/null; then
  log "skip: AskUserQuestion with duplicate question text"; exit 0
fi
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""')
FIRST_Q=$(printf '%s' "$QUESTIONS" | jq -r '.[0].question // ""' | tr '\n' ' ' | head -c 120)

# shellcheck source=/dev/null
source "$SCRIPTS/lib/keychain-get.sh" 2>/dev/null || { log "skip: keychain-get.sh not found"; exit 0; }
RECEIVER_URL=$(keychain_get pushover-action-receiver-url 2>/dev/null || true)
[ -n "$RECEIVER_URL" ] || { log "skip: pushover-action-receiver-url not set"; exit 0; }

ID="ask-$(openssl rand -hex 8)"
TOKEN=$(bash "$SCRIPTS/lib/action-token.sh" ask-answer "$ID" "$WAIT_SEC" 2>/dev/null) || {
  log "skip: token generation failed"; exit 0; }
case "$RECEIVER_URL" in *\?*) SEP="&" ;; *) SEP="?" ;; esac

mkdir -p "$DIR"
cleanup() { rm -f "$DIR/$ID.pending" "$DIR/$ID.answer" "$DIR/.$ID.pending.tmp"; }
trap cleanup EXIT
# 回答ページは .pending の中身（questions）からフォームを組む。書きかけを読ませないよう mv で置く
printf '%s' "$QUESTIONS" > "$DIR/.$ID.pending.tmp" && mv "$DIR/.$ID.pending.tmp" "$DIR/$ID.pending"

# Pushover の本文は 1024 文字まで（https://pushover.net/api "limited to 1024 4-byte UTF-8 characters"）。
# リンクと出所行（pushover-notify.sh が足す）の分を残し、質問と選択肢の部分だけを切り詰める
LINK="<a href=\"${RECEIVER_URL}${SEP}t=${TOKEN}\">👉 回答する（選択肢 / 自由入力）</a>"
FOOTER="（${WAIT_SEC} 秒で期限切れ。その後は Mac の選択画面に戻ります）"
MAX_TEXT=$(( 1024 - ${#LINK} - ${#FOOTER} - ${#CWD} - 40 ))
[ "$MAX_TEXT" -lt 100 ] && MAX_TEXT=100
TEXT=$(printf '%s' "$QUESTIONS" | jq -r --argjson max "$MAX_TEXT" '
  length as $n
  | [ to_entries[] | .key as $qi | .value as $q
    | ((if $n > 1 then "Q\($qi + 1). " else "" end)
       + (if ($q.header // "") != "" then "[\($q.header)] " else "" end)
       + ($q.question // ""))
      + ([ ($q.options // []) | to_entries[]
           | "\n \(.key + 1). \(.value.label // "")"
             + (if (.value.description // "") != "" then " — \(.value.description)" else "" end) ]
         | join(""))
  ] | join("\n\n")
  | @html
  # 長さはエスケープ後で数える（" → &quot; 等で伸びる）。切り口の書きかけの実体参照は落とす
  | (if length > $max then (.[0:($max - 1)] | sub("&[#a-zA-Z0-9]*$"; "")) + "…" else . end)')
BODY="${TEXT}

${LINK}
${FOOTER}"

NOTIFY_ONCE_REPORT=1 PUSHOVER_HTML=1 bash "$SCRIPTS/lib/notify-once.sh" \
  "$ID" "ask-$ID" "質問待ち: AskUserQuestion" "$BODY" 1 "$CWD"
RC=$?
if [ "$RC" -ne 0 ]; then
  log "skip: notification not sent (rc=${RC}) id=${ID} tool=AskUserQuestion"
  exit 0
fi
log "waiting id=${ID} tool=AskUserQuestion question=${FIRST_Q}"

DEADLINE=$(( $(date +%s) + WAIT_SEC ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$DIR/$ID.answer" ]; then
    # 元の入力（questions ほか）に answers を足して丸ごと返す（updatedInput は入力全体を置き換える）
    if OUT=$(printf '%s' "$INPUT" | jq -c --slurpfile a "$DIR/$ID.answer" '
        select(($a[0] | type) == "object")
        | {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow",
            updatedInput: (.tool_input + {answers: $a[0]})}}') && [ -n "$OUT" ]; then
      # 自由入力は本文を残さない（ログは平文のため）。答えた質問数だけ記録する
      log "answered id=${ID} answers=$(jq 'length' "$DIR/$ID.answer")"
      printf '%s\n' "$OUT"
      exit 0
    fi
    log "ignored malformed answer id=${ID}"
    exit 0
  fi
  # Mac に戻ってきたら待つのをやめ、Mac の選択画面に任せる（在席判定ができなくなったときも同じ）
  NOW_IDLE=$(idle_seconds)
  case "$NOW_IDLE" in
    ''|*[!0-9]*) log "idle time unavailable while waiting id=${ID}"; exit 0 ;;
  esac
  if [ "$NOW_IDLE" -lt 30 ]; then log "back at Mac id=${ID}"; exit 0; fi
  sleep "$POLL_SEC"
done
log "timeout id=${ID} tool=AskUserQuestion"
exit 0
