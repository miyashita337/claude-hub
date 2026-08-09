#!/bin/bash
# claude-error-loop-mock.sh — 常に同じエラーで失敗する fake `claude` CLI
# (Issue #386 / e2e-live S2-4)。
#
# 目的: orchestrate の error loop 判定（agent-base
# rules/general/orchestration-escalation-policy.md B-3「error loop = エラー署名が
# 3 回一致」）に、**実課金ゼロ・決定的**なワーカーを与える。実モデルは同じ失敗を
# 3 回踏むまで数十分かかり、出力も揺れるため、その層は本モックで置き換える。
#
# 応答は「エラー中核は毎回同一・可変部（ISO タイムスタンプ / 試行回数）だけ変化」に
# する。毎回バイト完全一致にしないのは意図的で、署名の正規化（可変部を落として
# 同一と判定できるか）まで検証するため。実 CLI のエラーも毎回タイムスタンプが違う。
#
# stdin/stdout と Stop hook POST の契約（{text, session_id}）は claude-mock.sh と
# 同一。違いは応答内容だけなので、Supervisor 側から見た経路は変わらない。
#
# Env:
#   SUPERVISOR_RELAY_URL        Stop hook 相当の POST 先。未設定なら stdout echo のみ。
#   CLAUDE_MOCK_SESSION_ID      既定 "mock-error-loop-$$"
#   CLAUDE_MOCK_ERROR_TEXT      毎回返すエラー中核（署名として一致すべき部分）
#   CLAUDE_MOCK_CURL_TIMEOUT    curl --max-time 秒。既定 5
#
# EOF (Ctrl-D / pipe close) で exit 0。

set -u

SESSION_ID="${CLAUDE_MOCK_SESSION_ID:-mock-error-loop-$$}"
ERROR_TEXT="${CLAUDE_MOCK_ERROR_TEXT:-Error: EACCES: permission denied, open '/tmp/e2e-error-loop.lock'}"
CURL_TIMEOUT="${CLAUDE_MOCK_CURL_TIMEOUT:-5}"

# jq は必須（claude-mock.sh と同じ理由: 任意の制御文字を含みうるテキストを安全に
# JSON 化する。壊れた payload を黙って送るより loud に落とす）。
if ! command -v jq >/dev/null 2>&1; then
  echo "claude-error-loop-mock.sh: jq is required for safe JSON encoding (install jq)" >&2
  exit 127
fi

json_escape() {
  printf '%s' "$1" | jq -Rs .
}

attempt=0
while IFS= read -r line; do
  # 空行はスキップ（ループは維持）。claude-mock.sh と同じ扱い。
  [ -z "$line" ] && continue

  attempt=$((attempt + 1))
  # 可変部（タイムスタンプ・試行回数）+ 不変のエラー中核。入力 $line は応答に
  # 含めない: 入力ごとに応答が変わると「同一エラーの反復」にならないため。
  reply="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] attempt ${attempt}: ${ERROR_TEXT}"
  printf '%s\n' "$reply"

  # Stop hook 相当（best-effort）。ネットワーク不可の環境でも stdout echo は残る。
  if [ -n "${SUPERVISOR_RELAY_URL:-}" ]; then
    text_json=$(json_escape "$reply")
    sid_json=$(json_escape "$SESSION_ID")
    payload="{\"text\":${text_json},\"session_id\":${sid_json}}"
    curl -s -X POST "$SUPERVISOR_RELAY_URL" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      --max-time "$CURL_TIMEOUT" \
      >/dev/null 2>&1 || true
  fi
done

exit 0
