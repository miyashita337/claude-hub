#!/bin/bash
# Issue #102: list all `claude` processes on the host, categorised by role.
#
# Categories:
#   supervisor      — Channel-Supervisor's own bun process (com.claude-hub.supervisor)
#   hijoguchi       — claudeHubExit bot (com.claude-hub.hijoguchi)
#   tmux-supervised — claude running inside a tmux session managed by the supervisor
#                     (on the `-L claude-hub` socket AND named by the supervisor's
#                     own `claude-<threadId12>` formula)
#   tmux-other      — claude in any other tmux session, INCLUDING hand-made
#                     sessions that merely share the `-L claude-hub` socket (#430)
#   subagent        — claude whose parent process is the claude binary (Task tool);
#                     matched on argv[0] basename, never a substring (#430)
#   interactive     — claude attached to a user's tty (no tmux), top-level
#   orphan          — anything that doesn't match the above
#
# Output columns: CATEGORY  PID  PPID  ETIME  RSS_MB  TMUX_SESSION  CWD  CMD
#
# Pure read-only; never sends signals. Pair with cleanup-idle-claude.sh
# (--dry-run / --apply) for the kill side.

set -euo pipefail

# `ps -A -o pid=,ppid=,etime=,rss=,command=` — all processes, fixed columns.
# Filter for command starting with `claude` or argv0 containing `/claude`.
ps_snapshot() {
  ps -Ao pid=,ppid=,etime=,rss=,command= | awk '
    {
      # Reconstruct full command from $5..$NF
      cmd = "";
      for (i = 5; i <= NF; i++) cmd = cmd (i == 5 ? "" : " ") $i;
      # Match: argv[0] is "claude" or path ending in /claude (with optional args)
      if (cmd ~ /^claude([ \t]|$)/ || cmd ~ /\/claude([ \t]|$)/) {
        printf "%s\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4, cmd;
      }
    }
  '
}

# Map PID → tmux session name (or empty if not in tmux).
tmux_session_for_pid() {
  local pid="$1"
  # Walk up the process tree looking for a tmux server, then map back.
  # Simpler: check if any tmux pane PID chain contains our pid.
  # tmux can emit: list-panes -a -F '#{pane_pid} #{session_name}'
  if ! command -v tmux >/dev/null 2>&1; then
    echo ""
    return
  fi
  # Try the supervisor socket first (Issue #83), then default.
  for socket_args in "-L claude-hub" ""; do
    # shellcheck disable=SC2086
    local panes
    panes=$(tmux $socket_args list-panes -a -F '#{pane_pid} #{session_name}' 2>/dev/null || true)
    [ -z "$panes" ] && continue
    local sess
    sess=$(awk -v target="$pid" '
      {
        # Walk the pane PID; if our PID descends from this pane PID,
        # we treat it as belonging to that session. We do a coarse
        # check: just match pane_pid==pid for now (children are detected
        # via the subagent rule).
        if ($1 == target) print $2;
      }
    ' <<<"$panes")
    if [ -n "$sess" ]; then
      echo "$sess"
      return
    fi
  done
  echo ""
}

# argv[0] basename of a pid (e.g. `claude` for /Users/x/.local/bin/claude).
# Empty output + non-zero exit when the pid is gone.
#
# Issue #430: classification must never test for the SUBSTRING "claude" in a
# full command line. The supervisor's tmux server runs as
#   tmux -L claude-hub new-session -d -s claude-<threadId> ... exec .../claude ...
# so its argv contains "claude" three times over. Comparing the basename of
# argv[0] instead answers the actual question ("is this process the claude
# binary?") and is immune to socket / session names that merely spell it.
argv0_basename() {
  local pid="$1" argv0
  argv0=$(ps -p "$pid" -o command= 2>/dev/null | awk '{print $1}')
  [ -z "$argv0" ] && return 1
  printf '%s' "${argv0##*/}"
}

# Does a tmux session name follow the supervisor's own naming formula?
#
# SessionManager.tmuxSessionNameFor() builds every session it starts as
# `claude-<first 12 chars of the Discord thread id>`
# (supervisor/src/session/manager.ts). Thread ids are numeric snowflakes, so a
# supervisor-managed name always matches ^claude-[0-9]{1,12}$.
#
# Issue #430: hand-made sessions on the same socket (observed: `claude-x`,
# `claude-tricky` — 9h idle, zero input) used to inherit the "never touch a
# Discord session" protection and could never be reclaimed. Only names that
# carry the supervisor's formula get that protection now.
is_supervisor_session_name() {
  [[ "$1" =~ ^claude-[0-9]{1,12}$ ]]
}

# Decide whether a given pid was launched by the supervisor's tmux socket.
# We check: ancestor chain contains a tmux process whose argv contains
# `-L claude-hub`.
is_supervisor_tmux_chain() {
  local pid="$1"
  local cur="$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$cur" ] || [ "$cur" = "0" ] || [ "$cur" = "1" ] && return 1
    local cmd
    cmd=$(ps -p "$cur" -o command= 2>/dev/null || true)
    if [ -z "$cmd" ]; then
      return 1
    fi
    if [[ "$cmd" == *"tmux"*"-L claude-hub"* ]]; then
      return 0
    fi
    local next
    next=$(ps -p "$cur" -o ppid= 2>/dev/null | tr -d ' ' || true)
    [ "$next" = "$cur" ] && return 1
    cur="$next"
  done
  return 1
}

# Working directory for a pid (best-effort; macOS lsof).
cwd_for_pid() {
  local pid="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{sub(/^n/,""); print; exit}'
  fi
}

# Categorise one row.
# $4 is the pid's tmux session name (empty when it owns no pane). It is passed
# in rather than looked up here because `main` needs the same value for its
# output column, and each lookup shells out to tmux once per socket.
classify() {
  local pid="$1" ppid="$2" cmd="$3" tsess="${4:-}"
  local parent_cmd
  parent_cmd=$(ps -p "$ppid" -o command= 2>/dev/null || true)

  # supervisor (Channel-Supervisor's own bun)
  if [[ "$cmd" == *"supervisor/index.ts"* || "$cmd" == *"Channel-Supervisor"* ]]; then
    echo "supervisor"
    return
  fi
  # hijoguchi watchdog / tmux-managed claudeHubExit
  if [[ "$parent_cmd" == *"start-hijoguchi.sh"* ]] || [[ "$cmd" == *"claudeHubExit"* ]]; then
    echo "hijoguchi"
    return
  fi
  # subagent (parent process IS the claude binary — Task tool child).
  # Basename comparison, not a substring of the parent's argv: see
  # argv0_basename() for why (#430).
  if [ "$(argv0_basename "$ppid" || true)" = "claude" ]; then
    echo "subagent"
    return
  fi
  # supervisor-managed tmux session: on the supervisor's socket AND carrying
  # its naming formula. A session on that socket whose name we resolved and
  # which does NOT match the formula is a hand-made session — reclaimable, so
  # it is demoted to `tmux-other`. If the name could not be resolved at all we
  # keep the protected category: never demote a session we failed to observe
  # (fail-safe, #430).
  if is_supervisor_tmux_chain "$pid"; then
    if [ -n "$tsess" ] && ! is_supervisor_session_name "$tsess"; then
      echo "tmux-other"
      return
    fi
    echo "tmux-supervised"
    return
  fi
  # other tmux
  if [ -n "$tsess" ]; then
    echo "tmux-other"
    return
  fi
  # interactive (attached to a tty without tmux)
  local tty
  tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ' || true)
  if [ -n "$tty" ] && [ "$tty" != "?" ] && [ "$tty" != "??" ]; then
    echo "interactive"
    return
  fi
  echo "orphan"
}

main() {
  local rows
  rows=$(ps_snapshot)
  if [ -z "$rows" ]; then
    printf "No claude processes found.\n"
    return 0
  fi
  printf "%-16s  %-7s  %-7s  %-12s  %-8s  %-30s  %s\n" \
    "CATEGORY" "PID" "PPID" "ETIME" "RSS_MB" "TMUX_SESSION" "CMD"
  while IFS=$'\t' read -r pid ppid etime rss cmd; do
    local cat tsess rss_mb
    tsess=$(tmux_session_for_pid "$pid")
    cat=$(classify "$pid" "$ppid" "$cmd" "$tsess")
    rss_mb=$(( rss / 1024 ))
    # Truncate long cmd for readability.
    local short_cmd="${cmd:0:80}"
    printf "%-16s  %-7s  %-7s  %-12s  %-8s  %-30s  %s\n" \
      "$cat" "$pid" "$ppid" "$etime" "$rss_mb" "${tsess:--}" "$short_cmd"
  done <<<"$rows"
}

# `LIST_CLAUDE_PROCESSES_LIB_ONLY=1 source scripts/list-claude-processes.sh`
# loads the classification predicates without taking a process snapshot, so the
# test suite can assert on them directly (#430). Any other invocation lists.
if [ "${LIST_CLAUDE_PROCESSES_LIB_ONLY:-}" != "1" ]; then
  main "$@"
fi
