# install-wsl-keepalive.ps1 - Windows-side companion to install-autostart.sh
#
# Problem (2026-11-05 incident): the WSL-internal autostart chain
# (systemd user units + linger, Issue #552) works - bots start 3s after WSL
# boots. But nothing on the WINDOWS side keeps WSL itself alive:
#   - Windows sleep / overnight maintenance can terminate the WSL VM
#     (observed: WSL poweroff at 03:08 JST while Windows stayed up)
#   - after a Windows reboot, WSL only boots when someone opens a terminal
# Result: Channel-Supervisor / claudeHubExit were down for 12h until a human
# opened a WSL terminal.
#
# Normally invoked by scripts/install-autostart.sh on WSL (no-op on macOS,
# where launchd keeps the bots alive and there is no VM to keep up).
#
# Fix: register a logon scheduled task that runs a hidden keep-alive loop:
#   while(true) { wsl.exe -d <distro> --exec sleep infinity; sleep 30s }
# - holds a client handle open  -> WSL idle-termination never fires
# - if the VM is killed anyway (sleep/maintenance/`wsl --shutdown`),
#   the loop re-boots WSL within 30s -> systemd units relaunch the bots
# - the task action is fully inline (no file dependency), because at logon
#   WSL is down and \\wsl.localhost paths are unreachable
#
# Side effect to know: `wsl --shutdown` is auto-undone within 30s while this
# task runs. To intentionally stop WSL: disable + stop the task first (below).
#
# This file is kept ASCII-only: Windows PowerShell 5.1 reads BOM-less files as
# the ANSI code page, so non-ASCII text could be mis-decoded.
#
# Usage (from WSL; install-autostart.sh passes the current distro):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w scripts/install-wsl-keepalive.ps1)" -Distro "$WSL_DISTRO_NAME"
#   powershell.exe ... -File ... -Uninstall     # stop the loop + remove the task
# Stop temporarily (Windows side). Disable comes first: Stop alone is undone
# by the 5-minute watchdog trigger.
#   Disable-ScheduledTask -TaskName claude-hub-wsl-keepalive
#   Stop-ScheduledTask -TaskName claude-hub-wsl-keepalive
#   wsl --shutdown
# Resume: Enable-ScheduledTask, then Start-ScheduledTask.

param(
  [string]$Distro = '',
  [switch]$Uninstall
)

# Register/Unregister report failures as non-terminating errors, which would
# still exit 0 under -File; Stop turns them into exit 1 for the caller.
$ErrorActionPreference = 'Stop'

$TaskName = 'claude-hub-wsl-keepalive'
# Matches the wsl.exe client the loop starts (see $loop below).
$KeepaliveCmdPattern = '%--exec sleep infinity%'

if ($Uninstall) {
  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Output "[wsl-keepalive] task $TaskName not installed; nothing to remove"
    exit 0
  }
  # Unregister alone leaves the running loop and its wsl.exe child alive, and
  # that child keeps holding the VM up after "uninstall".
  Stop-ScheduledTask -TaskName $TaskName
  Get-CimInstance Win32_Process -Filter "Name='wsl.exe' AND CommandLine LIKE '$KeepaliveCmdPattern'" |
    Invoke-CimMethod -MethodName Terminate | Out-Null
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "[wsl-keepalive] stopped and removed task $TaskName"
  exit 0
}

# The distro must be the one hosting the bots: with a wrong name the loop
# fails every 30s while the task still shows Running. The name is spliced into
# the task's command line, so only plain names are accepted.
if ($Distro -notmatch '^[A-Za-z0-9._-]+$') {
  Write-Error "[wsl-keepalive] -Distro is required and must match ^[A-Za-z0-9._-]+`$ (got '$Distro'). From WSL pass -Distro `"`$WSL_DISTRO_NAME`"."
}

# Inner loop: restart wsl.exe whenever it exits (VM killed / shutdown).
$loop = "while(`$true){ wsl.exe -d '$Distro' --exec sleep infinity; Start-Sleep -Seconds 30 }"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"$loop`""

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Watchdog trigger: the logon trigger alone fires once per logon, so if the
# keep-alive powershell itself dies (2026-11-09: exited 0xC000013A
# STATUS_CONTROL_C_EXIT and stayed dead) nothing restarts it until the next
# logon - RestartCount only covers failures to START. Re-firing every 5 min
# with MultipleInstances=IgnoreNew is a no-op while the loop is alive and a
# relaunch within 5 min after it dies.
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @($logonTrigger, $watchdogTrigger)

# ExecutionTimeLimit=0 is the load-bearing setting: the Task Scheduler default
# (PT72H) would silently kill the keep-alive after 3 days.
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Keep WSL (and claude-hub bots) running; re-boot WSL within 30s if the VM dies. Pair of scripts/install-autostart.sh (#552).' -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$t = Get-ScheduledTask -TaskName $TaskName
Write-Output "[wsl-keepalive] task=$($t.TaskName) state=$($t.State) distro=$Distro"
