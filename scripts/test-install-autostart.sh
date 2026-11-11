#!/bin/bash
# Tests for scripts/install-autostart.sh (Issue #552, Design A).
#
# Read-only / side-effect-free: everything runs through --dry-run and never
# invokes systemctl / launchctl / loginctl / the launchers. Portable to Linux
# CI. Guards OS detection, placeholder substitution, and the checked-in unit
# templates (analog of test-plist-placeholders.sh).
#
# Usage: bash scripts/test-install-autostart.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="${REPO_DIR}/scripts/install-autostart.sh"
SYSTEMD_SRC="${REPO_DIR}/systemd"

PASS=0; FAIL=0
assert() {
  local desc="$1"; shift
  if "$@"; then echo "PASS: $desc"; PASS=$((PASS + 1));
  else echo "FAIL: $desc"; FAIL=$((FAIL + 1)); fi
}
contains()     { echo "$1" | grep -qF -- "$2"; }
not_contains() { ! echo "$1" | grep -qF -- "$2"; }

run_installer() { # init -> dry-run stdout+stderr
  CLAUDE_HUB_INIT="$1" bash "${INSTALLER}" --dry-run 2>&1
}

echo "=== 1. checked-in unit templates keep placeholders (no hardcoded home) ==="
for unit in claude-hub-supervisor.service claude-hub-hijoguchi.service; do
  body="$(cat "${SYSTEMD_SRC}/${unit}")"
  assert "${unit}: has __HOME__ placeholder"   contains "$body" "__HOME__"
  assert "${unit}: no hardcoded /home/ path"   not_contains "$body" "/home/"
  assert "${unit}: no hardcoded /Users/ path"  not_contains "$body" "/Users/"
  assert "${unit}: Type=oneshot"               contains "$body" "Type=oneshot"
  assert "${unit}: RemainAfterExit=yes"        contains "$body" "RemainAfterExit=yes"
  assert "${unit}: WantedBy=default.target"    contains "$body" "WantedBy=default.target"
done
# Design A: each unit triggers its existing machine-local launcher.
assert "supervisor: ExecStart triggers start-claude-hub-supervisor.sh" \
  contains "$(cat "${SYSTEMD_SRC}/claude-hub-supervisor.service")" "ExecStart=/bin/bash __HOME__/start-claude-hub-supervisor.sh"
assert "hijoguchi: ExecStart triggers start-hijoguchi-wsl.sh" \
  contains "$(cat "${SYSTEMD_SRC}/claude-hub-hijoguchi.service")" "ExecStart=/bin/bash __HOME__/start-hijoguchi-wsl.sh"
# hijoguchi stops BOTH keep-alive sessions it owns.
assert "hijoguchi: ExecStop kills hijoguchi-wd" \
  contains "$(cat "${SYSTEMD_SRC}/claude-hub-hijoguchi.service")" "kill-session -t hijoguchi-wd"
assert "hijoguchi: ExecStop kills claudeHubExit" \
  contains "$(cat "${SYSTEMD_SRC}/claude-hub-hijoguchi.service")" "kill-session -t claudeHubExit"

echo "=== 2. CLAUDE_HUB_INIT override is honored ==="
out_sys="$(run_installer systemd)"
assert "systemd override detected"  contains "$out_sys" "Detected init system: systemd"
out_mac="$(run_installer launchd)"
assert "launchd override detected"  contains "$out_mac" "Detected init system: launchd"

echo "=== 3. systemd dry-run substitutes __HOME__ and touches nothing ==="
assert "rendered: no __HOME__ left"          not_contains "$out_sys" "__HOME__"
assert "rendered: real home ExecStart present" contains "$out_sys" "ExecStart=/bin/bash ${HOME}/start-hijoguchi-wsl.sh"
assert "rendered: supervisor launcher present" contains "$out_sys" "ExecStart=/bin/bash ${HOME}/start-claude-hub-supervisor.sh"
assert "dry-run touches nothing (no 'Wrote')"  not_contains "$out_sys" "Wrote ${HOME}/.config"
assert "dry-run does not require launchers"     contains "$out_sys" "would enable-linger"

echo "=== 4. launchd dry-run delegates to install-hijoguchi.sh ==="
assert "launchd mentions install-hijoguchi.sh" contains "$out_mac" "install-hijoguchi.sh"
assert "launchd mentions supervisor plist"     contains "$out_mac" "com.claude-hub.supervisor.plist"

echo "=== 5. WSL keep-alive task is wired only on WSL ==="
out_wsl="$(CLAUDE_HUB_WSL=1 run_installer systemd)"
assert "WSL: dry-run would register keep-alive task" contains "$out_wsl" "would register Windows task claude-hub-wsl-keepalive"
out_linux="$(CLAUDE_HUB_WSL=0 run_installer systemd)"
assert "native Linux: no keep-alive task"          not_contains "$out_linux" "claude-hub-wsl-keepalive"
assert "native Linux: says it skips keep-alive"    contains "$out_linux" "no WSL keep-alive task"
out_mac_wsl="$(CLAUDE_HUB_WSL=1 run_installer launchd)"
assert "macOS: never touches the WSL keep-alive"   not_contains "$out_mac_wsl" "keepalive"

echo "=== 6. keep-alive ps1 keeps its load-bearing settings ==="
PS1="${REPO_DIR}/scripts/install-wsl-keepalive.ps1"
ps1_body="$(cat "${PS1}")"
assert "ps1: task name matches installer"          contains "$ps1_body" "'claude-hub-wsl-keepalive'"
# Default PT72H would silently kill the loop after 3 days.
assert "ps1: ExecutionTimeLimit is zero"           contains "$ps1_body" "-ExecutionTimeLimit ([TimeSpan]::Zero)"
assert "ps1: starts at logon"                      contains "$ps1_body" "New-ScheduledTaskTrigger -AtLogOn"
# A dead loop is only relaunched by a repeating trigger (2026-11-09 incident).
assert "ps1: repeating watchdog trigger"           contains "$ps1_body" "-RepetitionInterval"
assert "ps1: no duplicate loops (IgnoreNew)"       contains "$ps1_body" "-MultipleInstances IgnoreNew"
assert "ps1: supports -Uninstall"                  contains "$ps1_body" "[switch]\$Uninstall"
assert "ps1: no hardcoded user path"               not_contains "$ps1_body" "C:\\Users\\"

# Parse check where PowerShell exists (GitHub ubuntu/macos runners ship pwsh).
if command -v pwsh >/dev/null 2>&1; then
  # -Command does not populate $args, so the path is spliced in (repo paths
  # contain no single quotes).
  parse_out="$(pwsh -NoProfile -Command "\$e=\$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${PS1}',[ref]\$null,[ref]\$e); \$e | ForEach-Object { \$_.Message }" 2>&1)"
  assert "ps1: parses without syntax errors" test -z "$parse_out"
  [ -n "$parse_out" ] && echo "$parse_out"
else
  echo "SKIP: pwsh not installed — ps1 parse check"
fi

echo
echo "=== Summary: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ]
