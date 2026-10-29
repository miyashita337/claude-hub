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
# Machine-local WSL launchers the systemd units trigger (Design A). These hold
# channel/bot IDs and are intentionally NOT tracked in the repo (fail-closed,
# Issue #63) — same status as the IDs filled into an installed launchd plist.
LAUNCHER_SUPERVISOR="${HOME}/start-claude-hub-supervisor.sh"
LAUNCHER_HIJOGUCHI="${HOME}/start-hijoguchi-wsl.sh"

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
  log "Wrote ${dest}/${UNIT_SUPERVISOR}"
  log "Wrote ${dest}/${UNIT_HIJOGUCHI}"

  # Lingering lets the user manager (and thus these units) start at boot without
  # an interactive login — the WSL-restart recovery this whole issue is about.
  if loginctl enable-linger "$USER" 2>/dev/null; then
    log "Enabled linger for $USER (units start at boot without login)"
  else
    log "WARN: 'loginctl enable-linger $USER' failed (may need: sudo loginctl enable-linger $USER)."
    log "      Without linger the services will not auto-start until you log in."
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now "${UNIT_SUPERVISOR}" "${UNIT_HIJOGUCHI}"
  log "Enabled + started both units. Status:"
  systemctl --user --no-pager --full status "${UNIT_SUPERVISOR}" "${UNIT_HIJOGUCHI}" 2>&1 | grep -E 'Loaded|Active' || true
}

systemd_uninstall() {
  local dest; dest="$(systemd_user_dir)"
  systemctl --user disable --now "${UNIT_SUPERVISOR}" "${UNIT_HIJOGUCHI}" 2>/dev/null || true
  rm -f "${dest}/${UNIT_SUPERVISOR}" "${dest}/${UNIT_HIJOGUCHI}"
  systemctl --user daemon-reload 2>/dev/null || true
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
  sed -e "s|/Users/YOUR_USER|$HOME|g" "${sup_tmpl}" > "${sup_plist}"
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
    [ "$MODE" = "install" ] && systemd_install || systemd_uninstall ;;
  launchd)
    [ "$MODE" = "install" ] && launchd_install || launchd_uninstall ;;
  *)
    log "ERROR: no supported init system detected (not Darwin, systemd not PID 1)."
    log "       Set CLAUDE_HUB_INIT=launchd|systemd to force."
    exit 1 ;;
esac
