#!/bin/bash
# list-mcp-load-time.sh — Measure MCP cold-start overhead for supervisor sessions
#
# Lists configured MCP servers (from `claude mcp list`) and measures startup
# wall-clock time across three configurations:
#   1. baseline (all MCPs + chrome enabled)
#   2. --no-chrome only
#   3. --no-chrome + --strict-mcp-config --mcp-config '{}'
#
# Issue #104 / Epic #101: supervisor sessions don't need most user-scope MCPs.
# This script quantifies how much cold-start time is reclaimed by disabling
# them.
#
# Usage:
#   bash scripts/list-mcp-load-time.sh
#   bash scripts/list-mcp-load-time.sh --runs 3   # average of 3 runs per config
#   bash scripts/list-mcp-load-time.sh --quick    # baseline + fully-disabled only
#
# Notes:
# - Per-MCP teardown is not measurable without Claude internals; this script
#   reports per-config totals and the inferred delta.
# - "lazy" status reflects MCPs the user has configured but the script
#   recommends not loading at supervisor cold-start.
# - Each measurement runs `claude -p '.'` which always issues a network round-
#   trip, so absolute numbers depend on connectivity. Deltas are still
#   meaningful.

set -euo pipefail

RUNS=1
QUICK=0
PROMPT='.'
TIMEOUT_SEC=120

while (( $# > 0 )); do
  case "$1" in
    --runs)   RUNS=$2; shift 2 ;;
    --quick)  QUICK=1; shift ;;
    --prompt) PROMPT=$2; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' CLI not found in PATH" >&2
  exit 1
fi

CLAUDE_VERSION=$(claude --version 2>/dev/null | head -1 || echo "(unknown)")
echo "=== MCP load-time profiler ==="
echo "claude: $CLAUDE_VERSION"
echo

#-----------------------------------------------------------------------------
# 1. Enumerate configured MCPs
#-----------------------------------------------------------------------------
echo "--- Configured MCPs (claude mcp list) ---"
MCP_LIST_RAW=$(claude mcp list 2>&1 || true)
echo "$MCP_LIST_RAW"
echo

#-----------------------------------------------------------------------------
# 2. Detect chrome integration status
#-----------------------------------------------------------------------------
CHROME_ENABLED=$(jq -r '.claudeInChromeDefaultEnabled // false' ~/.claude.json 2>/dev/null || echo "unknown")
CHROME_PAIRED=$(jq -r '.chromeExtension.pairedDeviceName // "(unpaired)"' ~/.claude.json 2>/dev/null || echo "(unknown)")
echo "--- Chrome integration ---"
echo "  enabled (default): $CHROME_ENABLED"
echo "  paired device:     $CHROME_PAIRED"
echo

#-----------------------------------------------------------------------------
# 3. Measure cold-start across configs
#-----------------------------------------------------------------------------
TMP_HOME=$(mktemp -d)
trap 'rm -rf "$TMP_HOME"' EXIT

# Run claude with given args; print elapsed ms (median of $RUNS runs).
measure() {
  local label="$1"; shift
  local samples=()
  local i
  for (( i=1; i<=RUNS; i++ )); do
    local start_ns end_ns elapsed_ms
    start_ns=$(date +%s%N)
    if ! timeout "${TIMEOUT_SEC}s" claude --output-format json -p "$PROMPT" "$@" >/dev/null 2>&1; then
      echo "  WARN: run $i for '$label' failed or timed out" >&2
      continue
    fi
    end_ns=$(date +%s%N)
    elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
    samples+=("$elapsed_ms")
    echo "  run $i: ${elapsed_ms} ms" >&2
  done
  if (( ${#samples[@]} == 0 )); then
    echo "$label	timeout"
    return
  fi
  # median
  local sorted
  sorted=$(printf '%s\n' "${samples[@]}" | sort -n)
  local n=${#samples[@]}
  local mid=$(( n / 2 ))
  local median
  median=$(echo "$sorted" | sed -n "$((mid + 1))p")
  echo "$label	$median"
}

declare -A RESULTS
echo "--- Cold-start measurements (median of $RUNS run(s); prompt='$PROMPT') ---"

# Run from a clean cwd (TMP_HOME) so project-scope .mcp.json doesn't skew results.
cd "$TMP_HOME"

echo "[1/3] baseline (all MCPs + chrome)..."
RESULTS[baseline]=$(measure "baseline" 2>/dev/null | cut -f2 || echo "timeout")
echo "  -> ${RESULTS[baseline]} ms"

echo "[2/3] --no-chrome only..."
RESULTS[no_chrome]=$(measure "no_chrome" --no-chrome 2>/dev/null | cut -f2 || echo "timeout")
echo "  -> ${RESULTS[no_chrome]} ms"

if (( QUICK == 0 )); then
  echo "[3/3] --no-chrome + --strict-mcp-config '{}' (supervisor recommended)..."
  RESULTS[supervisor]=$(measure "supervisor" --no-chrome --strict-mcp-config --mcp-config '{"mcpServers":{}}' 2>/dev/null | cut -f2 || echo "timeout")
  echo "  -> ${RESULTS[supervisor]} ms"
else
  echo "[3/3] skipped (--quick)"
fi

echo

#-----------------------------------------------------------------------------
# 4. Report
#-----------------------------------------------------------------------------
echo "--- Summary ---"
printf '%-50s | %-10s | %s\n' "config" "ms" "status"
printf '%s\n' "-------------------------------------------------------------------------------"

format_ms() {
  if [[ "$1" =~ ^[0-9]+$ ]]; then
    printf '%s' "$1"
  else
    printf '(%s)' "$1"
  fi
}

printf '%-50s | %-10s | %s\n' "baseline (all MCPs + chrome)" "$(format_ms "${RESULTS[baseline]}")" "loaded"
printf '%-50s | %-10s | %s\n' "--no-chrome" "$(format_ms "${RESULTS[no_chrome]}")" "chrome=disabled"
if (( QUICK == 0 )); then
  printf '%-50s | %-10s | %s\n' "--no-chrome + strict-mcp-config '{}'" "$(format_ms "${RESULTS[supervisor]}")" "all=disabled (lazy)"
fi
echo

# Per-MCP listing — individual transport-level latency.
# HTTP MCPs: time TLS+TTFB via curl HEAD; this is a lower bound on what claude
# pays at startup (claude additionally does capability discovery / auth, which
# we cannot isolate without claude internals).
# stdio MCPs: time spawning the command with closed stdin (init then exit).
echo "--- Per-MCP transport latency (lower bound) ---"
printf '%-40s | %-12s | %s\n' "MCP" "ms (own)" "status"
printf '%s\n' "------------------------------------------------------------------------"

measure_http() {
  local url="$1"
  local secs
  secs=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 -X HEAD "$url" 2>/dev/null || echo "0")
  awk -v s="$secs" 'BEGIN { printf "%.0f", s * 1000 }'
}

measure_stdio() {
  # $@ = command tokens; spawn with closed stdin and a 5s ceiling.
  local start_ns end_ns
  start_ns=$(date +%s%N)
  timeout 5s "$@" </dev/null >/dev/null 2>&1 || true
  end_ns=$(date +%s%N)
  echo $(( (end_ns - start_ns) / 1000000 ))
}

# Parse `claude mcp list` lines: "name: url-or-cmd - ✓ Connected" or "✗"
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^Checking ]] && continue
  # name appears before the first colon followed by a space
  name=$(echo "$line" | sed -E 's/^([^:]+):.*$/\1/' | sed 's/[[:space:]]*$//')
  if [[ -z "$name" || "$name" == "$line" ]]; then continue; fi
  rest=${line#*: }
  endpoint=${rest% - *}
  transport_ms="n/a"
  if [[ "$endpoint" =~ ^https?:// ]]; then
    transport_ms=$(measure_http "$endpoint")
  fi
  printf '%-40s | %-12s | %s\n' "$name" "$transport_ms" "lazy (disabled at startup)"
done <<< "$MCP_LIST_RAW"

# Chrome row — claude-in-chrome connects via the paired chrome extension; we
# cannot probe it from shell, so report the policy decision only.
printf '%-40s | %-12s | %s\n' "claude-in-chrome" "n/a" "lazy (--no-chrome at startup)"

echo

#-----------------------------------------------------------------------------
# 5. Estimated savings
#-----------------------------------------------------------------------------
if [[ "${RESULTS[baseline]}" =~ ^[0-9]+$ && "${RESULTS[no_chrome]}" =~ ^[0-9]+$ ]]; then
  chrome_save=$(( RESULTS[baseline] - RESULTS[no_chrome] ))
  echo "Estimated savings from --no-chrome:           ${chrome_save} ms"
fi
if (( QUICK == 0 )) && [[ "${RESULTS[baseline]}" =~ ^[0-9]+$ && "${RESULTS[supervisor]}" =~ ^[0-9]+$ ]]; then
  total_save=$(( RESULTS[baseline] - RESULTS[supervisor] ))
  echo "Estimated savings (supervisor 'none' profile): ${total_save} ms"
fi
