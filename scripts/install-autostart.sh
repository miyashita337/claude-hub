#!/bin/bash
# OS-portable autostart installer for the claude-hub resident jobs
# (Channel-Supervisor + claudeHubExit watchdog). Issue #552.
#
# One entrypoint, two init systems — both configs live in the repo side by side
# so moving the machine between macOS and WSL needs no rewrite:
#   macOS       -> launchd  (com.claude-hub.*.plist, existing)
#   WSL2/Linux  -> systemd user services (systemd/claude-hub-*.service, new)
#
# Design A (Issue #552): on WSL the systemd units are only the BOOT TRIGGER for
# the existing machine-local launchers (~/start-hijoguchi-wsl.sh and
# ~/start-claude-hub-supervisor.sh), which already own env injection,
# DISCORD_STATE_DIR isolation, the double-start guard and the keep-alive loop.
# systemd adds the one thing WSL lacked vs. launchd: start-at-boot.
#
# Detection order:
#   1. CLAUDE_HUB_INIT=launchd|systemd   (explicit override)
#   2. uname = Darwin                    -> launchd
#   3. systemd is PID 1 (incl. WSL2)     -> systemd
#   else: error (no supported init system found)
#
# On WSL (systemd path + Microsoft kernel) it also registers the Windows-side
# keep-alive task (scripts/install-wsl-keepalive.ps1). macOS and native Linux
# skip that step: launchd/systemd there run on the host itself, no VM to keep up.
#
# Usage:
#   bash scripts/install-autostart.sh              # install for this OS
#   bash scripts/install-autostart.sh --uninstall  # remove for this OS
#   bash scripts/install-autostart.sh --dry-run    # print what would happen,
#                                                   # touch nothing

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_SRC="${REPO_DIR}/systemd"
UNIT_SUPERVISOR="claude-hub-supervisor.service"
UNIT_HIJOGUCHI="claude-hub-hijoguchi.service"
# Health-check supplies crash-recovery the oneshot boot units lack (#268/#552).
UNIT_HEALTH_SVC="claude-hub-healthcheck.service"
UNIT_HEALTH_TIMER="claude-hub-healthcheck.timer"
# Machine-local WSL launchers the systemd units trigger (Design A). These hold
# channel/bot IDs and are intentionally NOT tracked in the repo (fail-closed,
# Issue #63) — same status as the IDs filled into an installed launchd plist.
LAUNCHER_SUPERVISOR="${HOME}/start-claude-hub-supervisor.sh"
LAUNCHER_HIJOGUCHI="${HOME}/start-hijoguchi-wsl.sh"
# WSL only: systemd starts the bots when the VM boots, but nothing on the
# Windows side keeps the VM itself up (2026-11-05: VM powered off overnight,
# bots down 12h). This registers a Windows scheduled task that holds WSL open.
KEEPALIVE_PS1="${REPO_DIR}/scripts/install-wsl-keepalive.ps1"

MODE="install"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    --dry-run)   DRY_RUN=1 ;;
    *) echo "[install-autostart] ERROR: unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[install-autostart] $*"; }

detect_init() {
  if [ -n "${CLAUDE_HUB_INIT:-}" ]; then
    echo "${CLAUDE_HUB_INIT}"; return 0
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "launchd"; return 0
  fi
  # systemd as PID 1 covers native Linux and WSL2 with systemd=true.
  if [ "$(cat /proc/1/comm 2>/dev/null)" = "systemd" ]; then
    echo "systemd"; return 0
  fi
  echo "unknown"; return 0
}

# WSL vs. native Linux share the systemd path; only WSL needs the Windows-side
# keep-alive. CLAUDE_HUB_WSL=1|0 overrides detection (tests, odd kernels).
is_wsl() {
  case "${CLAUDE_HUB_WSL:-}" in
    1) return 0 ;;
    0) return 1 ;;
  esac
  grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null
}

# ----- WSL keep-alive (Windows scheduled task) --------------------------------

# Args are passed through to the ps1. Returns non-zero on failure so the caller
# can surface it like the linger gap instead of silently skipping.
wsl_keepalive_run() {
  if ! command -v powershell.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
    log "WARN: powershell.exe / wslpath not found (WSL interop disabled?) — cannot manage the WSL keep-alive task."
    return 1
  fi
  local win_path; win_path="$(wslpath -w "${KEEPALIVE_PS1}")"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${win_path}" "$@"
}

wsl_keepalive_install() {
  # The task must boot THIS distro (the one hosting the bots); WSL sets
  # WSL_DISTRO_NAME in every session.
  local distro="${WSL_DISTRO_NAME:-}"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] WSL detected: would register Windows task claude-hub-wsl-keepalive for distro '${distro}' via ${KEEPALIVE_PS1}"
    return 0
  fi
  if [ -z "$distro" ]; then
    log "ACTION REQUIRED: WSL_DISTRO_NAME is empty — cannot tell which distro the keep-alive should boot."
    return 1
  fi
  if wsl_keepalive_run -Distro "$distro"; then
    log "Registered Windows task claude-hub-wsl-keepalive (keeps the WSL VM up; re-boots it within 30s if killed)."
  else
    log "ACTION REQUIRED: WSL keep-alive task not registered. Bots stop whenever Windows powers off the VM."
    log "  Run from WSL: powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"\$(wslpath -w ${KEEPALIVE_PS1})\" -Distro \"\$WSL_DISTRO_NAME\""
    return 1
  fi
}

wsl_keepalive_uninstall() {
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] WSL detected: would stop and remove Windows task claude-hub-wsl-keepalive"
    return 0
  fi
  wsl_keepalive_run -Uninstall || log "WARN: could not remove Windows task claude-hub-wsl-keepalive (remove it from Task Scheduler manually)."
}

# ----- systemd (WSL2/Linux) --------------------------------------------------

systemd_user_dir() { echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; }

# Render a unit template to stdout with __HOME__ substituted. Pure (stdout only)
# so --dry-run and the real install share one path and tests can diff output.
render_unit() { sed -e "s|__HOME__|${HOME}|g" "$1"; }

systemd_install() {
  local dest; dest="$(systemd_user_dir)"

  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] init=systemd  repo=${REPO_DIR}"
    log "[dry-run] would trigger launchers: ${LAUNCHER_SUPERVISOR}, ${LAUNCHER_HIJOGUCHI}"
    log "[dry-run] would write ${dest}/${UNIT_SUPERVISOR}:"
    render_unit "${SYSTEMD_SRC}/${UNIT_SUPERVISOR}"
    echo "----"
    log "[dry-run] would write ${dest}/${UNIT_HIJOGUCHI}:"
    render_unit "${SYSTEMD_SRC}/${UNIT_HIJOGUCHI}"
    echo "----"
    log "[dry-run] would enable-linger, daemon-reload, enable --now both units"
    if is_wsl; then wsl_keepalive_install; else log "[dry-run] native Linux: no WSL keep-alive task"; fi
    return 0
  fi

  # Design A reuses the existing launchers; they must be present + readable
  # (the units run them via `bash <launcher>`, so +x is not required).
  local missing=0
  for l in "${LAUNCHER_SUPERVISOR}" "${LAUNCHER_HIJOGUCHI}"; do
    if [ ! -r "$l" ]; then
      log "ERROR: launcher not found or not readable: $l"
      missing=1
    fi
  done
  if [ "$missing" = "1" ]; then
    log "These machine-local launchers inject the bot env + keep-alive loop."
    log "Create/restore them before installing, or run with --dry-run."
    exit 1
  fi

  mkdir -p "${dest}" "${REPO_DIR}/logs"
  render_unit "${SYSTEMD_SRC}/${UNIT_SUPERVISOR}" > "${dest}/${UNIT_SUPERVISOR}"
  render_unit "${SYSTEMD_SRC}/${UNIT_HIJOGUCHI}"  > "${dest}/${UNIT_HIJOGUCHI}"
  render_unit "${SYSTEMD_SRC}/${UNIT_HEALTH_SVC}"   > "${dest}/${UNIT_HEALTH_SVC}"
  render_unit "${SYSTEMD_SRC}/${UNIT_HEALTH_TIMER}" > "${dest}/${UNIT_HEALTH_TIMER}"
  log "Wrote ${dest}/${UNIT_SUPERVISOR}"
  log "Wrote ${dest}/${UNIT_HIJOGUCHI}"
  log "Wrote ${dest}/${UNIT_HEALTH_SVC} + ${UNIT_HEALTH_TIMER}"

  # Lingering lets the user manager (and thus these units) start at boot without
  # an interactive login — the WSL-restart recovery this whole issue is about.
  local linger_ok=1
  if loginctl enable-linger "$USER" 2>/dev/null; then
    log "Enabled linger for $USER (units start at boot without login)"
  else
    linger_ok=0
    log "WARN: 'loginctl enable-linger $USER' failed."
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now "${UNIT_SUPERVISOR}" "${UNIT_HIJOGUCHI}"
  # The timer (not the oneshot service) is the enabled unit; it fires the
  # health-check service on a schedule to recover dead bots (#268/#552).
  systemctl --user enable --now "${UNIT_HEALTH_TIMER}"
  log "Enabled + started both units + healthcheck timer. Status:"
  systemctl --user --no-pager --full status "${UNIT_SUPERVISOR}" "${UNIT_HIJOGUCHI}" 2>&1 | grep -E 'Loaded|Active' || true

  # Without the keep-alive the units above only run while something else keeps
  # the VM up — same "looks installed but won't survive" gap as missing linger.
  local keepalive_ok=1
  if is_wsl; then
    wsl_keepalive_install || keepalive_ok=0
  fi

  # linger is required for the stated goal (boot-without-login, Issue #552). The
  # services are up + enabled now, but without linger they stop when the last
  # session closes and won't start before first login. Return non-zero so the
  # gap is surfaced instead of silently masked (CodeRabbit #553).
  if [ "$linger_ok" = 0 ]; then
    log "ACTION REQUIRED: services are running now, but will NOT survive logout or"
    log "  auto-start on boot until you enable linger manually:"
    log "    sudo loginctl enable-linger $USER"
    return 1
  fi
  [ "$keepalive_ok" = 1 ]
}

systemd_uninstall() {
  local dest; dest="$(systemd_user_dir)"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] would disable + remove ${UNIT_SUPERVISOR}, ${UNIT_HIJOGUCHI}, ${UNIT_HEALTH_TIMER} from ${dest}"
    if is_wsl; then wsl_keepalive_uninstall; fi
    return 0
  fi
  systemctl --user disable --now "${UNIT_HEALTH_TIMER}" 2>/dev/null || true
  systemctl --user disable --now "${UNIT_SUPERVISOR}" "${UNIT_HIJOGUCHI}" 2>/dev/null || true
  rm -f "${dest}/${UNIT_SUPERVISOR}" "${dest}/${UNIT_HIJOGUCHI}" \
        "${dest}/${UNIT_HEALTH_SVC}" "${dest}/${UNIT_HEALTH_TIMER}"
  systemctl --user daemon-reload 2>/dev/null || true
  # Remove the keep-alive too, or it keeps re-booting a VM the user wants down.
  if is_wsl; then wsl_keepalive_uninstall; fi
  log "Removed systemd user units. (linger left intact; run 'loginctl disable-linger $USER' to undo.)"
}

# ----- launchd (macOS) -------------------------------------------------------
# The existing mac path already works; this branch just wires it into the single
# entrypoint so a Mac-returning machine installs with the same command. The
# hijoguchi job delegates to the existing install-hijoguchi.sh; the supervisor
# plist is installed with the sed+bootstrap convention documented in the plist.

launchd_install() {
  local uid plist_dir sup_tmpl sup_plist
  uid="$(id -u)"
  plist_dir="$HOME/Library/LaunchAgents"
  sup_tmpl="${REPO_DIR}/com.claude-hub.supervisor.plist"
  sup_plist="${plist_dir}/com.claude-hub.supervisor.plist"

  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] init=launchd — would run: bash ${REPO_DIR}/scripts/install-hijoguchi.sh"
    log "[dry-run] and install ${sup_plist} (sed /Users/YOUR_USER -> \$HOME, launchctl bootstrap)"
    return 0
  fi

  log "Installing claudeHubExit (hijoguchi) via install-hijoguchi.sh ..."
  bash "${REPO_DIR}/scripts/install-hijoguchi.sh"

  log "Installing Channel-Supervisor launchd job ..."
  mkdir -p "${plist_dir}" "${REPO_DIR}/logs"
  # Do NOT clobber an already-installed plist: the template ships
  # HIJOGUCHI_CHANNEL_ID blank by design (fail-closed), so re-templating would
  # wipe a manually-filled id and silently disable the /session compact route
  # (CodeRabbit #553). Only generate from template on a fresh install.
  if [ -f "${sup_plist}" ]; then
    log "Existing ${sup_plist} found — NOT overwriting (preserves filled HIJOGUCHI_CHANNEL_ID)."
    log "  To regenerate from template, remove it first: rm ${sup_plist}"
  else
    sed -e "s|/Users/YOUR_USER|$HOME|g" "${sup_tmpl}" > "${sup_plist}"
  fi
  launchctl bootout "gui/${uid}/com.claude-hub.supervisor" 2>/dev/null || true
  launchctl bootstrap "gui/${uid}" "${sup_plist}"
  log "Done. NOTE: fill HIJOGUCHI_CHANNEL_ID in ${sup_plist} then reload (bootout+bootstrap) — see plist comments."
}

launchd_uninstall() {
  local uid; uid="$(id -u)"
  bash "${REPO_DIR}/scripts/install-hijoguchi.sh" --uninstall || true
  launchctl bootout "gui/${uid}/com.claude-hub.supervisor" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.claude-hub.supervisor.plist"
  log "Removed launchd jobs."
}

# ----- dispatch --------------------------------------------------------------

INIT="$(detect_init)"
log "Detected init system: ${INIT}  (override with CLAUDE_HUB_INIT=launchd|systemd)"

case "${INIT}" in
  systemd)
    # if/else (not `&& ... || ...`): with the short-circuit form a FAILED
    # install would fall through to uninstall, and its non-zero exit would be
    # masked (CodeRabbit #553). if/else propagates the install failure.
    if [ "$MODE" = "install" ]; then systemd_install; else systemd_uninstall; fi ;;
  launchd)
    if [ "$MODE" = "install" ]; then launchd_install; else launchd_uninstall; fi ;;
  *)
    log "ERROR: no supported init system detected (not Darwin, systemd not PID 1)."
    log "       Set CLAUDE_HUB_INIT=launchd|systemd to force."
    exit 1 ;;
esac
