#!/usr/bin/env bash
# Issue #135: supervisor relay segment latency 集計 consumer
#
# Writer: supervisor/src/session/latency-logger.ts (recordRelayLatency)
# 出力先: ~/.claude/state/relay-latency-log.jsonl (1 行 1 計測の JSON)
#
# 使い方:
#   bash scripts/analyze-relay-latency.sh                # default ログを集計
#   bash scripts/analyze-relay-latency.sh /tmp/test.jsonl  # 別ファイルを指定
#
# 出力:
#   - 計測件数 / 期間 / load_avg_1m の min/max
#   - segment 別 median (ms)
#   - dominant segment (median が最大のもの)
#   - error_segment 内訳 (ある場合)
#
# observability ルール: rules/general/observability.md「consumer 必須」(RW-023)
# に従い、本 script は writer (latency-logger.ts) と同 PR で導入される。

set -euo pipefail

LOG_PATH="${1:-${HOME}/.claude/state/relay-latency-log.jsonl}"

if [ ! -f "${LOG_PATH}" ]; then
  echo "ERROR: log file not found: ${LOG_PATH}" >&2
  echo "ヒント: supervisor が稼働して relay が 1 度実行されると生成されます。" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required" >&2
  exit 1
fi

LINES=$(wc -l < "${LOG_PATH}" | tr -d ' ')
if [ "${LINES}" = "0" ]; then
  echo "WARN: log file is empty: ${LOG_PATH}"
  exit 0
fi

echo "=== Relay Latency Analysis ==="
echo "Log:    ${LOG_PATH}"
echo "Count:  ${LINES} measurements"

FIRST_TS=$(head -1 "${LOG_PATH}" | jq -r '.timestamp // "n/a"')
LAST_TS=$(tail -1 "${LOG_PATH}" | jq -r '.timestamp // "n/a"')
echo "Period: ${FIRST_TS} .. ${LAST_TS}"

LOAD_STATS=$(jq -s '[.[].load_avg_1m] | "min=\(min) max=\(max) avg=\(add/length | .*100|round/100)"' "${LOG_PATH}")
echo "Load:   ${LOAD_STATS}"
echo

# segment 名 (latency-logger.ts SEGMENT_NAMES と一致させる)
SEGMENTS="a b c d_e_c f"

echo "=== Segment Median (ms) ==="
printf "%-10s %10s %10s %10s %10s\n" "segment" "count" "median" "min" "max"

# dominant 判定用に median を一時保持
DOMINANT_NAME=""
DOMINANT_VALUE=-1

for seg in ${SEGMENTS}; do
  # 各行の .segments[seg] を集約し null を除外して median を計算 (-s で slurp)
  STATS=$(jq -rs --arg s "${seg}" '
    [.[].segments[$s] // empty] as $vals |
    if ($vals | length) == 0 then
      "0|0|0|0"
    else
      ($vals | sort) as $sorted |
      ($sorted | length) as $n |
      ($sorted[($n / 2 | floor)]) as $med |
      "\($n)|\($med)|\($sorted[0])|\($sorted[-1])"
    end' "${LOG_PATH}")

  COUNT=$(echo "${STATS}" | cut -d'|' -f1)
  MEDIAN=$(echo "${STATS}" | cut -d'|' -f2)
  MIN=$(echo "${STATS}" | cut -d'|' -f3)
  MAX=$(echo "${STATS}" | cut -d'|' -f4)
  printf "%-10s %10s %10s %10s %10s\n" "${seg}" "${COUNT}" "${MEDIAN}" "${MIN}" "${MAX}"

  if [ "${COUNT}" -gt 0 ] && [ "${MEDIAN}" -gt "${DOMINANT_VALUE}" ]; then
    DOMINANT_VALUE="${MEDIAN}"
    DOMINANT_NAME="${seg}"
  fi
done

echo
if [ -n "${DOMINANT_NAME}" ]; then
  echo "dominant: ${DOMINANT_NAME} (${DOMINANT_VALUE}ms)"
else
  echo "dominant: n/a (no segment data)"
fi

# === Delivery (Issue #223): 到達率 ===
#
# 「relay 応答がユーザーに届いたか」の二値 (writer 側 latency-logger.ts の
# delivered field) を全期間 + 日次で集計する。修正の前後で日次 rate を見比べれば
# silent regression (誰も気付かない到達率の劣化, RW-023 型) を検知できる。
#
# attempts は delivered field を持つ行だけを数える: #223 以前の行は field 自体が
# 無く、delivered とも dropped とも判定できないため、分母に入れると rate が
# 実態より低く出てしまう。
DELIVERY=$(jq -rs '
  [.[] | select(.delivered != null)] as $rec |
  ($rec | length) as $attempts |
  ([$rec[] | select(.delivered)] | length) as $delivered |
  "\($attempts)|\($delivered)"' "${LOG_PATH}")
DELIVERY_ATTEMPTS=$(echo "${DELIVERY}" | cut -d'|' -f1)
DELIVERY_OK=$(echo "${DELIVERY}" | cut -d'|' -f2)

echo
if [ "${DELIVERY_ATTEMPTS}" -eq 0 ]; then
  echo "=== Delivery (全期間) ==="
  echo "attempts=0 (delivered field を持つ計測がまだありません)"
else
  DELIVERY_DROPPED=$((DELIVERY_ATTEMPTS - DELIVERY_OK))
  DELIVERY_RATE=$(jq -rn --argjson d "${DELIVERY_OK}" --argjson a "${DELIVERY_ATTEMPTS}" \
    '($d / $a * 1000 | round / 10)')
  echo "=== Delivery (全期間) ==="
  echo "attempts=${DELIVERY_ATTEMPTS} delivered=${DELIVERY_OK} dropped=${DELIVERY_DROPPED} rate=${DELIVERY_RATE}%"

  echo
  echo "=== Delivery (日次) ==="
  jq -rs '
    [.[] | select(.delivered != null)]
    | group_by(.timestamp[:10])[]
    | . as $day
    | ($day | length) as $attempts
    | ([$day[] | select(.delivered)] | length) as $delivered
    | "\($day[0].timestamp[:10]) attempts=\($attempts) delivered=\($delivered) dropped=\($attempts - $delivered) rate=\($delivered / $attempts * 1000 | round / 10)%"
  ' "${LOG_PATH}"
fi

# error_segment 集計 (ある場合のみ)
ERROR_COUNT=$(jq -s '[.[] | select(.error_segment != null)] | length' "${LOG_PATH}")
if [ "${ERROR_COUNT}" -gt 0 ]; then
  echo
  echo "=== Errors (${ERROR_COUNT} of ${LINES}) ==="
  jq -r 'select(.error_segment != null) | "\(.timestamp)\t\(.error_segment)"' "${LOG_PATH}" \
    | sort | uniq -c | sort -rn | head -10
fi
