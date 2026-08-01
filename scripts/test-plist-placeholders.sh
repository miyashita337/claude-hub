#!/bin/bash
# Guards the launchd plist install convention (Issue #198).
#
# Every tracked plist template must keep operator paths as a placeholder, never
# a hardcoded /Users/<login>, so a fresh machine can install it with a single
# sed. PR #194 (#151) fixed com.claude-hub.gc-attachments.plist and #198 fixed
# the remaining two — this test stops the next one from regressing.
#
# Portable on purpose: the placeholder check — the regression this test exists
# for — runs on Linux CI too. `plutil -lint` is macOS-only, so it is an extra
# assertion that SKIPs elsewhere rather than a hard requirement.
#
# Deliberately NOT asserting strict XML well-formedness: launchd/plutil use a
# lenient parser and accept `--` inside comments (com.claude-hub.gc-attachments
# .plist documents `install-gc-attachments.sh --uninstall` that way), which a
# spec-strict XML parser rejects. Gating on a stricter parser than the actual
# consumer would only force us to mangle copy-pasteable commands.
#
# Read-only: never touches ~/Library/LaunchAgents or launchctl.
#
# Usage: bash scripts/test-plist-placeholders.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

PASS=0
FAIL=0
SKIP=0
assert() {
  local desc="$1"; shift
  if "$@"; then
    echo "PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "FAIL: $desc"; FAIL=$((FAIL + 1))
  fi
}

quiet() {
  "$@" >/dev/null 2>&1
}

# PLIST_TEST_NO_PLUTIL=1 forces the no-plutil path so the Linux CI branch can be
# exercised from macOS.
have_plutil=0
if [ "${PLIST_TEST_NO_PLUTIL:-0}" != "1" ] && command -v plutil >/dev/null 2>&1; then
  have_plutil=1
fi

# Only tracked templates are in scope. Generated plists (e.g.
# com.claude-hub.hijoguchi.plist, gitignored) legitimately contain real paths.
TEMPLATES=$(git ls-files '*.plist' '*.plist.template')
assert "tracked plist templates found" test -n "$TEMPLATES"

for tpl in $TEMPLATES; do
  # 1. No hardcoded operator home — the regression this test exists for.
  #    /Users/YOUR_USER is the sanctioned placeholder; __HOME__ (hijoguchi
  #    template) carries no /Users prefix at all.
  hardcoded=$(grep -oE '/Users/[A-Za-z0-9._-]+' "$tpl" | grep -v '^/Users/YOUR_USER$' | sort -u || true)
  if [ -n "$hardcoded" ]; then
    echo "FAIL: $tpl has hardcoded home path(s): $(echo "$hardcoded" | tr '\n' ' ')"
    echo "      Use the /Users/YOUR_USER placeholder and substitute \$HOME on install."
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $tpl has no hardcoded /Users/<login> path"
    PASS=$((PASS + 1))
  fi

  # 2. The documented install substitution round-trips: after replacing the
  #    placeholder with $HOME, nothing unresolved is left.
  out="$TMPDIR_TEST/$(echo "$tpl" | tr '/' '_')"
  sed -e "s|/Users/YOUR_USER|$HOME|g" -e "s|__HOME__|$HOME|g" "$tpl" > "$out"
  assert "$tpl leaves no placeholder after substitution" \
    test -z "$(grep -oE 'YOUR_USER|__HOME__' "$out" || true)"

  # 3. Both the template (placeholders are plain strings) and the substituted
  #    output must stay valid plists per the platform's own parser.
  if [ "$have_plutil" -eq 1 ]; then
    assert "$tpl passes plutil -lint" quiet plutil -lint "$tpl"
    assert "$tpl substitutes to a plutil-valid plist" quiet plutil -lint "$out"
  else
    echo "SKIP: $tpl plutil -lint (macOS-only tool not available)"
    SKIP=$((SKIP + 2))
  fi
done

echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
