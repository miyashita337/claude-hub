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

not() {
  ! "$@"
}

# 否定アサーション用（サブシェル bash -c を避ける）
not() {
  ! "$@"
}

# stdout を捨てて実行（assert 自身の PASS/FAIL 出力は殺さない）
quiet() {
  "$@" >/dev/null 2>&1
}

PLIST="$TMPDIR_TEST/com.claude-hub.gc-attachments.plist"

# 1. install (generate only) succeeds
GC_PLIST_DIR="$TMPDIR_TEST" GC_SKIP_LOAD=1 bash "$TARGET" >/dev/null
assert "plist generated at destination" test -f "$PLIST"

# 2. placeholder fully substituted
assert "no YOUR_USER placeholder remains" not grep -q YOUR_USER "$PLIST"

# 3. plist is valid XML per plutil
assert "plist passes plutil -lint" quiet plutil -lint "$PLIST"

# 4. paths point at the real HOME
assert "ProgramArguments uses \$HOME path" grep -q "$HOME/claude-hub/supervisor/src/session/gc-attachments.ts" "$PLIST"

# 5. bun path resolves to the installer environment's bun (or the ~/.bun fallback)
EXPECTED_BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
assert "bun path substituted to environment bun" grep -q "<string>$EXPECTED_BUN</string>" "$PLIST"

# 6. idempotent re-run overwrites without error
GC_PLIST_DIR="$TMPDIR_TEST" GC_SKIP_LOAD=1 bash "$TARGET" >/dev/null
assert "re-run succeeds (idempotent)" test -f "$PLIST"

# 7. uninstall removes the plist
GC_PLIST_DIR="$TMPDIR_TEST" GC_SKIP_LOAD=1 bash "$TARGET" --uninstall >/dev/null
assert "uninstall removes plist" test ! -f "$PLIST"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
