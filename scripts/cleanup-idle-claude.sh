#!/bin/bash
# Issue #102: detect and (optionally) terminate idle `claude` processes
# to reduce CPU/IO contention during cold-start of new sessions.
#
# Defaults to --dry-run. The --apply flag is required to actually send
# signals; pair with `bash scripts/list-claude-processes.sh` first to
# inspect what's running.
#
# Safety rails (always-on, cannot be disabled):
#   - Never kills the supervisor or hijoguchi processes themselves
#   - Never kills `tmux-supervised` claude (those are Discord sessions)
#   - Never kills subagents (their parent claude would deadlock)
#   - Skips PIDs listed in CLEANUP_CLAUDE_ALLOWLIST_PIDS env var (comma-separated)
#   - Idle threshold: process must have been running >= IDLE_MINUTES (default 30)
#                     AND its working directory's most-recently-modified .jsonl
#                     transcript must be older than IDLE_MINUTES, OR no jsonl found.
#
# Exit codes:
#   0 — completed (dry-run reported, or kills succeeded / no candidates)
#   1 — at least one kill failed
#   2 — argument or environment error

set -euo pipefail

MODE="dry-run"
IDLE_MINUTES="${IDLE_MINUTES:-30}"
ALLOWLIST="${CLEANUP_CLAUDE_ALLOWLIST_PIDS:-}"

usage() {
  cat <<'EOF'
Usage: cleanup-idle-claude.sh [--dry-run | --apply] [--idle-minutes N]

Options:
  --dry-run            Show kill candidates without sending signals (default)
  --apply              Actually SIGTERM candidates (SIGKILL after 10s if alive)
  --idle-minutes N     Override idle threshold (default: 30)

Environment:
  IDLE_MINUTES                       Same as --idle-minutes
  CLEANUP_CLAUDE_ALLOWLIST_PIDS      Comma-separated PIDs to never touch
EOF
}

# Parse args.
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    --idle-minutes) IDLE_MINUTES="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[cleanup-idle-claude] unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if ! [[ "$IDLE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "[cleanup-idle-claude] --idle-minutes must be a non-negative integer" >&2
  exit 2
fi

# Build allowlist as comma-bounded string (bash 3.2 / macOS default has no
# associative arrays). RW-028 / RW-006: avoid `declare -A` and `readarray`
# in scripts that ship to macOS hosts.
ALLOWLIST_STR=""
if [ -n "$ALLOWLIST" ]; then
  ALLOWLIST_STR=",$(echo "$ALLOWLIST" | tr -d ' '),"
fi

is_in_allowlist() {
  local pid="$1"
  [ -z "$ALLOWLIST_STR" ] && return 1
  [[ "$ALLOWLIST_STR" == *",${pid},"* ]]
}

# Reuse classify logic from the lister via subshell.
LIST_SCRIPT="$(dirname "$0")/list-claude-processes.sh"
if [ ! -x "$LIST_SCRIPT" ] && [ ! -f "$LIST_SCRIPT" ]; then
  echo "[cleanup-idle-claude] cannot find $LIST_SCRIPT" >&2
  exit 2
fi

# Get categorised rows. The lister produces a header + rows; skip the header.
# RW-028 compat: bash 3.2 (macOS default) has no `mapfile`/`readarray`;
# accumulate via while-read instead.
ROWS=()
while IFS= read -r line; do
  ROWS+=("$line")
done < <(bash "$LIST_SCRIPT" | tail -n +2)

if [ "${#ROWS[@]}" -eq 0 ]; then
  echo "[cleanup-idle-claude] no claude processes found"
  exit 0
fi

# Convert ETIME ([[dd-]hh:]mm:ss) to total minutes.
etime_to_minutes() {
  local etime="$1"
  local days=0 hours=0 minutes=0
  if [[ "$etime" == *-* ]]; then
    days="${etime%%-*}"
    etime="${etime#*-}"
  fi
  # etime is now [[hh:]mm:ss]
  local parts
  IFS=':' read -ra parts <<<"$etime"
  case "${#parts[@]}" in
    3) hours="${parts[0]}"; minutes="${parts[1]}" ;;
    2) minutes="${parts[0]}" ;;
    *) minutes=0 ;;
  esac
  echo $(( days * 24 * 60 + 10#$hours * 60 + 10#$minutes ))
}

# Best-effort: check if the process's transcript jsonl was modified recently.
# Returns 0 (true, recent) if any open *.jsonl was touched within IDLE_MINUTES,
# 1 (false, idle) otherwise.
has_recent_activity() {
  local pid="$1" threshold="$2"
  if ! command -v lsof >/dev/null 2>&1; then
    # Without lsof we can't tell — assume idle to be conservative; the
    # etime gate above already protects very short-lived processes.
    return 1
  fi
  # Find any .jsonl file the process holds open and stat it.
  local files
  files=$(lsof -a -p "$pid" 2>/dev/null | awk '/\.jsonl$/{print $NF}')
  [ -z "$files" ] && return 1
  local now
  now=$(date +%s)
  local cutoff=$(( now - threshold * 60 ))
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    local mtime
    if [[ "$OSTYPE" == darwin* ]]; then
      mtime=$(stat -f '%m' "$f" 2>/dev/null || echo 0)
    else
      mtime=$(stat -c '%Y' "$f" 2>/dev/null || echo 0)
    fi
    if [ "$mtime" -gt "$cutoff" ]; then
      return 0
    fi
  done <<<"$files"
  return 1
}

CANDIDATES=()
PROTECTED_REASONS=()

# Final-line-of-defense: verify a PID's argv[0] is actually `claude` (or
# ends in `/claude`) before we'd ever signal it. The lister regex is
# loose enough to include tmux/awk subshells whose argv embeds "claude"
# somewhere; the category filter usually catches those, but if anything
# slips through to the kill loop, this guard refuses to fire.
is_genuine_claude_executable() {
  local pid="$1"
  local argv0
  argv0=$(ps -p "$pid" -o command= 2>/dev/null | awk '{print $1}')
  [ -z "$argv0" ] && return 1
  local base
  base="${argv0##*/}"
  [ "$base" = "claude" ]
}

for row in "${ROWS[@]}"; do
  # Columns are space-padded by printf in the lister.
  read -ra fields <<<"$row"
  local_cat="${fields[0]}"
  local_pid="${fields[1]}"
  local_etime="${fields[3]}"

  # Always-on protections.
  case "$local_cat" in
    supervisor|hijoguchi|tmux-supervised|subagent)
      PROTECTED_REASONS+=("$local_pid: protected category=$local_cat")
      continue
      ;;
  esac
  if is_in_allowlist "$local_pid"; then
    PROTECTED_REASONS+=("$local_pid: in CLEANUP_CLAUDE_ALLOWLIST_PIDS")
    continue
  fi
  # Idle gates.
  local_minutes=$(etime_to_minutes "$local_etime")
  if [ "$local_minutes" -lt "$IDLE_MINUTES" ]; then
    PROTECTED_REASONS+=("$local_pid: etime ${local_minutes}m < threshold ${IDLE_MINUTES}m")
    continue
  fi
  if has_recent_activity "$local_pid" "$IDLE_MINUTES"; then
    PROTECTED_REASONS+=("$local_pid: recent .jsonl activity within ${IDLE_MINUTES}m")
    continue
  fi
  if ! is_genuine_claude_executable "$local_pid"; then
    PROTECTED_REASONS+=("$local_pid: argv0 is not claude (lister false positive)")
    continue
  fi
  CANDIDATES+=("$local_cat $local_pid $local_etime")
done

echo "[cleanup-idle-claude] mode: $MODE  idle_threshold: ${IDLE_MINUTES}m"
if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "  No idle claude processes found above threshold."
  echo "  Protected (skipped): ${#PROTECTED_REASONS[@]}"
  for r in "${PROTECTED_REASONS[@]}"; do echo "    - $r"; done
  exit 0
fi

echo "  Candidates (${#CANDIDATES[@]}):"
for c in "${CANDIDATES[@]}"; do
  echo "    - $c"
done
echo "  Protected (${#PROTECTED_REASONS[@]} skipped):"
for r in "${PROTECTED_REASONS[@]}"; do echo "    - $r"; done

if [ "$MODE" = "dry-run" ]; then
  echo
  echo "  Run with --apply to send SIGTERM (then SIGKILL after 10s) to candidates."
  exit 0
fi

# --apply: SIGTERM, wait, SIGKILL stragglers.
exit_code=0
for c in "${CANDIDATES[@]}"; do
  read -ra cf <<<"$c"
  pid="${cf[1]}"
  echo "  -> SIGTERM $pid"
  if ! kill -TERM "$pid" 2>/dev/null; then
    echo "     failed (process gone or no permission)"
    exit_code=1
    continue
  fi
done
sleep 10
for c in "${CANDIDATES[@]}"; do
  read -ra cf <<<"$c"
  pid="${cf[1]}"
  if kill -0 "$pid" 2>/dev/null; then
    echo "  -> still alive, SIGKILL $pid"
    if ! kill -KILL "$pid" 2>/dev/null; then
      echo "     failed"
      exit_code=1
    fi
  fi
done
echo "[cleanup-idle-claude] done (exit $exit_code)"
exit "$exit_code"
