#!/bin/bash
# Install the gc-attachments launchd job (daily GC of tmp/attachments, Issue #151 案B).
# Generates the plist from the repo template (substituting the /Users/YOUR_USER
# placeholder), installs it to ~/Library/LaunchAgents, and loads it.
# Idempotent: re-running replaces the plist and reloads the job.
#
# Usage: bash scripts/install-gc-attachments.sh
#   --uninstall   Stop and remove the job
#
# Test overrides (used by scripts/test-install-gc-attachments.sh):
#   GC_PLIST_DIR   install destination (default ~/Library/LaunchAgents)
#   GC_SKIP_LOAD=1 generate/install only, skip launchctl (no persistence change)

set -euo pipefail

LABEL="com.claude-hub.gc-attachments"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_DIR/com.claude-hub.gc-attachments.plist"
PLIST_DIR="${GC_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$PLIST_DIR/$LABEL.plist"
GUI_UID=$(id -u)

# root で実行すると logs/ や plist の所有権が root になり、一般ユーザーの
# launchd ジョブがログを書けず起動失敗する（gui/0 への登録も意図外）。
if [ "$GUI_UID" -eq 0 ]; then
  echo "[install] ERROR: Do not run this script as root/sudo. Run as the login user." >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  echo "[install] Uninstalling $LABEL..."
  if [ "${GC_SKIP_LOAD:-0}" != "1" ]; then
    launchctl bootout "gui/$GUI_UID/$LABEL" 2>/dev/null || true
  fi
  rm -f "$PLIST"
  echo "[install] Done. Job removed."
  exit 0
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "[install] ERROR: Template not found: $TEMPLATE" >&2
  exit 1
fi

# launchd fails to spawn the job when the log directory is missing.
mkdir -p "$REPO_DIR/logs"
mkdir -p "$PLIST_DIR"

# bun が Homebrew 等でインストールされている環境では ~/.bun/bin/bun が
# 存在しないため、実行環境の bun 実パスを検出して置換する（無ければ
# テンプレート既定の ~/.bun/bin/bun にフォールバック）。
BUN_PATH="$(command -v bun || echo "$HOME/.bun/bin/bun")"
echo "[install] Generating plist from template..."
echo "[install]   HOME=$HOME"
echo "[install]   bun=$BUN_PATH"
sed -e "s|/Users/YOUR_USER/.bun/bin/bun|$BUN_PATH|g" \
    -e "s|/Users/YOUR_USER|$HOME|g" "$TEMPLATE" > "$PLIST"
if grep -q "YOUR_USER" "$PLIST"; then
  echo "[install] ERROR: placeholder substitution failed: $PLIST" >&2
  exit 1
fi
echo "[install] Written: $PLIST"

if [ "${GC_SKIP_LOAD:-0}" = "1" ]; then
  echo "[install] GC_SKIP_LOAD=1: skipping launchctl (generate/install only)."
  exit 0
fi

# Stop existing job if loaded (idempotent reload)
launchctl bootout "gui/$GUI_UID/$LABEL" 2>/dev/null || true

echo "[install] Loading job..."
launchctl bootstrap "gui/$GUI_UID" "$PLIST"

echo "[install] Verifying..."
if launchctl print "gui/$GUI_UID/$LABEL" >/dev/null 2>&1; then
  echo "[install] loaded: $LABEL"
else
  echo "[install] ERROR: job not visible in launchctl after load" >&2
  exit 1
fi
echo "[install] Done. Runs daily at 04:00. Manual run: launchctl kickstart -k gui/$GUI_UID/$LABEL"
echo "[install] Logs: $REPO_DIR/logs/gc-attachments.stdout.log / .stderr.log"
