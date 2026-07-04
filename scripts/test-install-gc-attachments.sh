#!/bin/bash
# Tests for scripts/install-gc-attachments.sh (generation/idempotency only —
# GC_SKIP_LOAD=1 keeps launchctl untouched so the test never mutates launchd).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$SCRIPT_DIR/install-gc-attachments.sh"
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

PASS=0
FAIL=0
assert() {
  local desc="$1"; shift
  if "$@"; then
    echo "PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "FAIL: $desc"; FAIL=$((FAIL + 1))
  fi
}

PLIST="$TMPDIR_TEST/com.claude-hub.gc-attachments.plist"

# 1. install (generate only) succeeds
GC_PLIST_DIR="$TMPDIR_TEST" GC_SKIP_LOAD=1 bash "$TARGET" >/dev/null
assert "plist generated at destination" test -f "$PLIST"

# 2. placeholder fully substituted
assert "no YOUR_USER placeholder remains" bash -c "! grep -q YOUR_USER '$PLIST'"

# 3. plist is valid XML per plutil
assert "plist passes plutil -lint" plutil -lint "$PLIST" >/dev/null

# 4. paths point at the real HOME
assert "ProgramArguments uses \$HOME path" grep -q "$HOME/claude-hub/supervisor/src/session/gc-attachments.ts" "$PLIST"

# 5. idempotent re-run overwrites without error
GC_PLIST_DIR="$TMPDIR_TEST" GC_SKIP_LOAD=1 bash "$TARGET" >/dev/null
assert "re-run succeeds (idempotent)" test -f "$PLIST"

# 6. uninstall removes the plist
GC_PLIST_DIR="$TMPDIR_TEST" GC_SKIP_LOAD=1 bash "$TARGET" --uninstall >/dev/null
assert "uninstall removes plist" bash -c "test ! -f '$PLIST'"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
