#!/bin/bash
# Install the claudeHubExit (hijoguchi) launchd service.
# Generates plist from template, installs to ~/Library/LaunchAgents, and loads it.
#
# Usage: bash scripts/install-hijoguchi.sh
#   --uninstall   Stop and remove the service

set -euo pipefail

LABEL="com.claude-hub.hijoguchi"
TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/com.claude-hub.hijoguchi.plist.template"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
GUI_UID=$(id -u)

if [ "${1:-}" = "--uninstall" ]; then
  echo "[install] Uninstalling $LABEL..."
  launchctl bootout "gui/$GUI_UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "[install] Done. Service removed."
  exit 0
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "[install] ERROR: Template not found: $TEMPLATE" >&2
  exit 1
fi

echo "[install] Generating plist from template..."
echo "[install]   HOME=$HOME"
mkdir -p "$PLIST_DIR"
sed "s|__HOME__|$HOME|g" "$TEMPLATE" > "$PLIST"
echo "[install] Written: $PLIST"

# Stop existing service if running
launchctl bootout "gui/$GUI_UID/$LABEL" 2>/dev/null || true

echo "[install] Loading service..."
launchctl bootstrap "gui/$GUI_UID" "$PLIST"

echo "[install] Verifying..."
STATE=$(launchctl print "gui/$GUI_UID/$LABEL" 2>&1 | grep "state" | head -1 || echo "unknown")
echo "[install] $STATE"
echo "[install] Done. Use 'launchctl kickstart -k gui/$GUI_UID/$LABEL' to restart."
