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
#                     AND we must have POSITIVELY OBSERVED that it has been
#                     quiet for that long (see below)
#   - Unobservable == protected. A process whose activity we cannot measure is
#     never a candidate, and --apply re-observes every candidate immediately
#     before signalling it.
#
# Activity observation (Issue #430):
#   This used to ask lsof for .jsonl files the process holds OPEN and treat
#   "no file found" as "idle". That is fail-DEADLY, and it fired constantly:
#   claude appends to its transcript and closes it rather than holding the fd,
#   so the lookup returns nothing even for a busy session — and on hosts where
#   lsof is not on PATH (macOS keeps it in /usr/sbin, which the supervisor's
#   own PATH omits) the lookup could not run at all. Every claude older than
#   IDLE_MINUTES was therefore reported idle, including sessions mid-task.
#
#   Two positive signals replace it, tried in order:
#     1. tmux pane activity — #{session_activity} / #{window_activity} of the
#        pane whose pane_pid is the process (epoch seconds).
#     2. transcript mtime — newest *.jsonl under
#        $HOME/.claude/projects/<cwd with every [^A-Za-z0-9-] replaced by ->,
#        the process cwd coming from lsof.
#   Neither available => `unknown` => protected.
#
# Exit codes:
#   0 — completed (dry-run reported, or kills succeeded / no candidates)
#   1 — at least one kill failed
#   2 — argument or environment error

set -euo pipefail

MODE="dry-run"
IDLE_MINUTES="${IDLE_MINUTES:-30}"
ALLOWLIST="${CLEANUP_CLAUDE_ALLOWLIST_PIDS:-}"

# Injectable dependencies. Defaults are the plain command names / real lister;
# the test suite points these at stubs so the observation logic can be driven
# deterministically without touching a live claude process.
TMUX_BIN="${CLEANUP_CLAUDE_TMUX_BIN:-tmux}"
LSOF_BIN="${CLEANUP_CLAUDE_LSOF_BIN:-lsof}"
PROJECTS_DIR="${CLEANUP_CLAUDE_PROJECTS_DIR:-${HOME:-}/.claude/projects}"
KILL_GRACE_SECONDS="${CLEANUP_CLAUDE_KILL_GRACE_SECONDS:-10}"

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
  CLEANUP_CLAUDE_KILL_GRACE_SECONDS  Seconds between SIGTERM and SIGKILL (10)
  CLEANUP_CLAUDE_LIST_SCRIPT         Override the process lister (testing)
  CLEANUP_CLAUDE_TMUX_BIN            Override the tmux binary (testing)
  CLEANUP_CLAUDE_LSOF_BIN            Override the lsof binary (testing)
  CLEANUP_CLAUDE_PROJECTS_DIR        Override ~/.claude/projects (testing)
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

if ! [[ "$KILL_GRACE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "[cleanup-idle-claude] CLEANUP_CLAUDE_KILL_GRACE_SECONDS must be a non-negative integer" >&2
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
LIST_SCRIPT="${CLEANUP_CLAUDE_LIST_SCRIPT:-$(dirname "$0")/list-claude-processes.sh}"
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

mtime_of() {
  local f="$1"
  if [[ "$OSTYPE" == darwin* ]]; then
    stat -f '%m' "$f" 2>/dev/null || true
  else
    stat -c '%Y' "$f" 2>/dev/null || true
  fi
}

# One `pane_pid session_activity window_activity` line per tmux pane, across
# both the supervisor's socket and whatever socket this shell inherits.
#
# Taken as a single snapshot rather than per-PID: a live host runs a handful of
# claude processes and each lookup would otherwise re-shell tmux twice, which
# made the whole run take seconds. Refreshed explicitly (see --apply) whenever
# a reading must be current rather than merely consistent.
PANE_SNAPSHOT=""
load_pane_snapshot() {
  PANE_SNAPSHOT=""
  command -v "$TMUX_BIN" >/dev/null 2>&1 || return 0
  local socket_args out
  for socket_args in "-L claude-hub" ""; do
    # shellcheck disable=SC2086
    out=$("$TMUX_BIN" $socket_args list-panes -a \
            -F '#{pane_pid} #{session_activity} #{window_activity}' 2>/dev/null || true)
    [ -n "$out" ] && PANE_SNAPSHOT="${PANE_SNAPSHOT}${out}"$'\n'
  done
  return 0
}

# Epoch seconds of the most recent tmux activity for the pane whose pane_pid is
# $1, or empty when the pid owns no pane (or tmux is unavailable).
#
# `#{session_activity}` / `#{window_activity}` are epoch seconds. Both are read
# and the larger wins: session_activity can lag behind the window that is
# actually being written to (measured on the supervisor's socket: the live
# session reported session_activity 8m old while window_activity was current).
tmux_last_activity() {
  local pid="$1"
  [ -z "$PANE_SNAPSHOT" ] && return 0
  awk -v target="$pid" '
    $1 == target {
      latest = $2 + 0;
      if ($3 + 0 > latest) latest = $3 + 0;
      print latest;
      exit;
    }
  ' <<<"$PANE_SNAPSHOT"
}

# Epoch seconds of the newest transcript *.jsonl belonging to the process's
# working directory, or empty when it cannot be located.
#
# Claude Code stores transcripts under
# `~/.claude/projects/<cwd>/<session-uuid>.jsonl`, where <cwd> is the absolute
# path with every character outside [A-Za-z0-9-] replaced by `-`. Verified
# against live directories on this host, e.g.
#   /Users/x/corp/.claude/worktrees/corp_selector_Proposal
#     -> -Users-x-corp--claude-worktrees-corp-selector-Proposal
# The encoding is an internal Claude Code detail, so a miss (directory absent,
# or the rule changed) yields empty => `unknown` => protected, never "idle".
transcript_last_mtime() {
  local pid="$1"
  command -v "$LSOF_BIN" >/dev/null 2>&1 || return 0
  local cwd
  cwd=$("$LSOF_BIN" -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{sub(/^n/,""); print; exit}')
  [ -z "$cwd" ] && return 0
  local encoded dir
  encoded=$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9-]/-/g')
  dir="${PROJECTS_DIR}/${encoded}"
  [ -d "$dir" ] || return 0
  local newest=0 f m
  for f in "$dir"/*.jsonl; do
    [ -e "$f" ] || continue
    m=$(mtime_of "$f")
    [ -z "$m" ] && continue
    [ "$m" -gt "$newest" ] && newest="$m"
  done
  [ "$newest" -eq 0 ] && return 0
  printf '%s' "$newest"
}

# Observe how long a process has been quiet.
#
# Prints "<state> <detail>" where state is one of:
#   active  — measured activity within the threshold: do not touch
#   idle    — measured activity older than the threshold: eligible
#   unknown — no observation source answered: protected (fail-safe)
#
# The `unknown` state is the whole point of Issue #430. The previous
# implementation had no such state: any failure to observe was reported as
# idle, which is how a session that was actively working became the single
# kill candidate on this host.
observe_activity() {
  local pid="$1" threshold_min="$2"
  local now cutoff ts age_min
  now=$(date +%s)
  cutoff=$(( now - threshold_min * 60 ))

  ts=$(tmux_last_activity "$pid")
  if [ -z "$ts" ]; then
    ts=$(transcript_last_mtime "$pid")
    if [ -n "$ts" ]; then
      age_min=$(( (now - ts) / 60 ))
      if [ "$ts" -gt "$cutoff" ]; then
        echo "active transcript-mtime ${age_min}m-ago"
      else
        echo "idle transcript-mtime ${age_min}m-ago"
      fi
      return 0
    fi
    echo "unknown no-activity-source (tmux pane and transcript both unreadable)"
    return 0
  fi

  age_min=$(( (now - ts) / 60 ))
  if [ "$ts" -gt "$cutoff" ]; then
    echo "active tmux-activity ${age_min}m-ago"
  else
    echo "idle tmux-activity ${age_min}m-ago"
  fi
}

CANDIDATES=()
PROTECTED_REASONS=()

# bash 3.2 (macOS default) expands "${arr[@]}" of an EMPTY array to an unbound
# variable error under `set -u`, so every iteration of an array that can be
# empty needs a length guard. PROTECTED_REASONS is empty whenever every listed
# process becomes a candidate — rare on a live host, which is why this only
# surfaced under test (RW-028 / RW-006).
print_protected_reasons() {
  [ "${#PROTECTED_REASONS[@]}" -eq 0 ] && return 0
  local r
  for r in "${PROTECTED_REASONS[@]}"; do echo "    - $r"; done
}

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

load_pane_snapshot

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
  # Cheap identity guard before the observation work: the lister's regex also
  # catches its own awk subshell, and there is no point measuring the activity
  # of something we would refuse to signal anyway.
  if ! is_genuine_claude_executable "$local_pid"; then
    PROTECTED_REASONS+=("$local_pid: argv0 is not claude (lister false positive)")
    continue
  fi
  local_observation=$(observe_activity "$local_pid" "$IDLE_MINUTES")
  local_state="${local_observation%% *}"
  local_detail="${local_observation#* }"
  case "$local_state" in
    active)
      PROTECTED_REASONS+=("$local_pid: active — $local_detail")
      continue
      ;;
    unknown)
      # Fail-safe (#430): we could not measure this process, so we must not
      # assume it is doing nothing.
      PROTECTED_REASONS+=("$local_pid: activity unobservable, protected — $local_detail")
      continue
      ;;
  esac
  CANDIDATES+=("$local_cat $local_pid $local_etime $local_detail")
done

echo "[cleanup-idle-claude] mode: $MODE  idle_threshold: ${IDLE_MINUTES}m"
if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "  No idle claude processes found above threshold."
  echo "  Protected (skipped): ${#PROTECTED_REASONS[@]}"
  print_protected_reasons
  exit 0
fi

echo "  Candidates (${#CANDIDATES[@]}):"
for c in "${CANDIDATES[@]}"; do
  echo "    - $c"
done
echo "  Protected (${#PROTECTED_REASONS[@]} skipped):"
print_protected_reasons

if [ "$MODE" = "dry-run" ]; then
  echo
  echo "  Each candidate line ends with the measurement that proved it idle."
  echo "  Run with --apply to send SIGTERM (then SIGKILL after ${KILL_GRACE_SECONDS}s) to candidates;"
  echo "  --apply re-measures every candidate immediately before signalling it."
  exit 0
fi

# --apply: re-observe, SIGTERM, wait, SIGKILL stragglers.
#
# The re-observation is not redundant with the loop above. Candidates are
# selected from a snapshot; between that snapshot and the signal a session can
# wake up (a Discord message lands, a queued dispatch starts). Re-measuring
# immediately before each SIGTERM keeps "never kill a working session" true at
# the instant it matters, not merely when the list was built (#430).
#
# SIGKILL only ever targets a pid we actually SIGTERMed. `KILLED_STR` is a
# comma-bounded string rather than an array because bash 3.2 (macOS default)
# errors on "${arr[@]}" when the array is empty under `set -u`, and this list
# is empty whenever every candidate woke up (RW-028 / RW-006).
exit_code=0
KILLED_STR=","
for c in "${CANDIDATES[@]}"; do
  read -ra cf <<<"$c"
  pid="${cf[1]}"
  # Fresh reading, not the snapshot the candidate list was built from.
  load_pane_snapshot
  recheck=$(observe_activity "$pid" "$IDLE_MINUTES")
  if [ "${recheck%% *}" != "idle" ]; then
    echo "  -> SKIP $pid (re-check before signal: $recheck)"
    continue
  fi
  echo "  -> SIGTERM $pid"
  if ! kill -TERM "$pid" 2>/dev/null; then
    echo "     failed (process gone or no permission)"
    exit_code=1
    continue
  fi
  KILLED_STR="${KILLED_STR}${pid},"
done
if [ "$KILLED_STR" = "," ]; then
  echo "[cleanup-idle-claude] no process was signalled (all candidates woke up)"
  echo "[cleanup-idle-claude] done (exit $exit_code)"
  exit "$exit_code"
fi
sleep "$KILL_GRACE_SECONDS"
for c in "${CANDIDATES[@]}"; do
  read -ra cf <<<"$c"
  pid="${cf[1]}"
  [[ "$KILLED_STR" == *",${pid},"* ]] || continue
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
