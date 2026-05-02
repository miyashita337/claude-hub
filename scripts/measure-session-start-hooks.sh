#!/usr/bin/env bash
# scripts/measure-session-start-hooks.sh
# SessionStart hooks の個別実行時間を測定する。
#
# Usage:
#   bash scripts/measure-session-start-hooks.sh
#   bash scripts/measure-session-start-hooks.sh --hooks-dir <path>
#   bash scripts/measure-session-start-hooks.sh --runs 3
#   bash scripts/measure-session-start-hooks.sh --json
#
# Options:
#   --hooks-dir <path>  測定対象 hook ディレクトリ (default: ~/.claude/hooks)
#   --runs <N>          各 hook を N 回実行して中央値を採用 (default: 1)
#   --json              機械可読な JSON 出力
#
# 出力例:
#   branch-sync-check.sh: 828ms
#   check-domain-expert.sh: 421ms
#   log-session-start.sh: 1430ms
#   restore-from-bak.sh: 1986ms
#   session-start-guardrails.sh: 8491ms
#   ---
#   total: 13156ms
#
# 関連:
#   - Issue #103 (SessionStart hooks の並列化と軽量化)
#   - Epic #101 (Claude session cold start を 30s 以下に短縮)
#   - settings.json: ~/.claude/settings.json の SessionStart matcher=startup

set -uo pipefail

HOOKS_DIR="${HOME}/.claude/hooks"
RUNS=1
JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hooks-dir)
      HOOKS_DIR="$2"; shift 2 ;;
    --hooks-dir=*)
      HOOKS_DIR="${1#--hooks-dir=}"; shift ;;
    --runs)
      RUNS="$2"; shift 2 ;;
    --runs=*)
      RUNS="${1#--runs=}"; shift ;;
    --json)
      JSON=1; shift ;;
    -h|--help)
      sed -n '2,21p' "$0"; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$HOOKS_DIR" ]; then
  echo "ERROR: hooks dir not found: $HOOKS_DIR" >&2
  exit 2
fi

# 対象 hook 一覧 (~/.claude/settings.json の SessionStart matcher=startup と一致)
TARGETS=(
  branch-sync-check.sh
  check-domain-expert.sh
  log-session-start.sh
  restore-from-bak.sh
  session-start-guardrails.sh
)

# ms 単位タイムスタンプ (macOS bash 3.2 + python3 で算出)
now_ms() {
  python3 -c 'import time; print(int(time.time()*1000))'
}

# 中央値算出 (整列済み配列の真ん中)
median_ms() {
  local sorted
  sorted=$(printf '%s\n' "$@" | sort -n)
  local n
  n=$(printf '%s\n' "$sorted" | wc -l | tr -d ' ')
  local mid=$(( (n + 1) / 2 ))
  printf '%s\n' "$sorted" | sed -n "${mid}p"
}

declare -a RESULTS_KEY=()
declare -a RESULTS_VAL=()
TOTAL=0

for hook in "${TARGETS[@]}"; do
  path="$HOOKS_DIR/$hook"
  if [ ! -e "$path" ]; then
    RESULTS_KEY+=("$hook")
    RESULTS_VAL+=("MISSING")
    continue
  fi

  samples=()
  for _ in $(seq 1 "$RUNS"); do
    start=$(now_ms)
    bash "$path" </dev/null >/dev/null 2>&1 || true
    end=$(now_ms)
    samples+=($((end - start)))
  done

  ms=$(median_ms "${samples[@]}")
  RESULTS_KEY+=("$hook")
  RESULTS_VAL+=("$ms")
  TOTAL=$((TOTAL + ms))
done

if [ "$JSON" -eq 1 ]; then
  printf '{"hooks_dir":"%s","runs":%d,"results":{' "$HOOKS_DIR" "$RUNS"
  for i in "${!RESULTS_KEY[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    printf '"%s":%s' "${RESULTS_KEY[$i]}" "${RESULTS_VAL[$i]}"
  done
  printf '},"total":%d}\n' "$TOTAL"
else
  for i in "${!RESULTS_KEY[@]}"; do
    val="${RESULTS_VAL[$i]}"
    if [ "$val" = "MISSING" ]; then
      printf '%s: MISSING\n' "${RESULTS_KEY[$i]}"
    else
      printf '%s: %sms\n' "${RESULTS_KEY[$i]}" "$val"
    fi
  done
  echo "---"
  printf 'total: %dms\n' "$TOTAL"
fi
