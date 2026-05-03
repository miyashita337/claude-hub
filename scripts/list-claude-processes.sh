#!/bin/bash
# Issue #102: list all `claude` processes on the host, categorised by role.
#
# Categories:
#   supervisor      — Channel-Supervisor's own bun process (com.claude-hub.supervisor)
#   hijoguchi       — claudeHubExit bot (com.claude-hub.hijoguchi)
#   tmux-supervised — claude running inside a tmux session managed by the supervisor
#                     (the parent tmux process itself is the supervisor's tmux socket)
#   tmux-other      — claude running inside any other tmux session
#   subagent        — claude whose parent PID is itself a `claude` process (Task tool)
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
classify() {
  local pid="$1" ppid="$2" cmd="$3"
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
  # subagent (parent is itself claude)
  if [[ "$parent_cmd" == *claude* && "$parent_cmd" != *"start-hijoguchi"* ]]; then
    echo "subagent"
    return
  fi
  # supervisor-managed tmux session
  if is_supervisor_tmux_chain "$pid"; then
    echo "tmux-supervised"
    return
  fi
  # other tmux
  local tsess
  tsess=$(tmux_session_for_pid "$pid")
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
    cat=$(classify "$pid" "$ppid" "$cmd")
    tsess=$(tmux_session_for_pid "$pid")
    rss_mb=$(( rss / 1024 ))
    # Truncate long cmd for readability.
    local short_cmd="${cmd:0:80}"
    printf "%-16s  %-7s  %-7s  %-12s  %-8s  %-30s  %s\n" \
      "$cat" "$pid" "$ppid" "$etime" "$rss_mb" "${tsess:--}" "$short_cmd"
  done <<<"$rows"
}

main "$@"
