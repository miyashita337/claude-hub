#!/usr/bin/env bash
# Issue #103: measure-session-start-hooks.sh のスモークテスト
#
# 検証項目:
#   T1: --hooks-dir 指定で対象 dir を切替できる
#   T2: 出力に各 hook 名と "ms" が含まれる
#   T3: --json で機械可読出力
#   T4: hook 不在の場合 MISSING を表示
#   T5: --runs 3 で複数回計測しても fail しない

set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/measure-session-start-hooks.sh"
TMP_BASE="${TMPDIR:-/tmp}/measure-test-$$"
PASS=0
FAIL=0

cleanup() { [ -d "$TMP_BASE" ] && /bin/rm -rf "$TMP_BASE" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$TMP_BASE/hooks"
# 軽量なダミー hook を作成
for hook in branch-sync-check check-domain-expert log-session-start \
            restore-from-bak session-start-guardrails; do
  cat > "$TMP_BASE/hooks/${hook}.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$TMP_BASE/hooks/${hook}.sh"
done

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "PASS: $name"; PASS=$((PASS + 1))
  else
    echo "FAIL: $name (needle=[$needle] not in haystack)"; FAIL=$((FAIL + 1))
  fi
}

# T1: --hooks-dir で dir 切替
output=$(bash "$SCRIPT" --hooks-dir "$TMP_BASE/hooks" 2>&1)
assert_contains "T1 branch-sync hook listed" "$output" "branch-sync-check.sh"
assert_contains "T1 ms suffix in output" "$output" "ms"
assert_contains "T1 total line" "$output" "total:"

# T2: 全 5 hook が出力に含まれる
for hook in branch-sync-check.sh check-domain-expert.sh log-session-start.sh \
            restore-from-bak.sh session-start-guardrails.sh; do
  assert_contains "T2 $hook listed" "$output" "$hook"
done

# T3: --json で機械可読
json_out=$(bash "$SCRIPT" --hooks-dir "$TMP_BASE/hooks" --json 2>&1)
assert_contains "T3 json hooks_dir" "$json_out" '"hooks_dir"'
assert_contains "T3 json results" "$json_out" '"results"'
assert_contains "T3 json total" "$json_out" '"total"'

# T4: 1 つ hook を削除した場合 MISSING が出る
/bin/rm "$TMP_BASE/hooks/branch-sync-check.sh"
miss_out=$(bash "$SCRIPT" --hooks-dir "$TMP_BASE/hooks" 2>&1)
assert_contains "T4 MISSING marker" "$miss_out" "branch-sync-check.sh: MISSING"
# 復活させる
cat > "$TMP_BASE/hooks/branch-sync-check.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP_BASE/hooks/branch-sync-check.sh"

# T5: --runs 3 が fail しない
runs_out=$(bash "$SCRIPT" --hooks-dir "$TMP_BASE/hooks" --runs 3 2>&1)
ec=$?
[ "$ec" -eq 0 ] && { echo "PASS: T5 --runs 3 exit 0"; PASS=$((PASS + 1)); } \
                || { echo "FAIL: T5 --runs 3 exit=$ec"; FAIL=$((FAIL + 1)); }

# T6: 不在 dir で exit 2
bash "$SCRIPT" --hooks-dir "$TMP_BASE/nonexistent" >/dev/null 2>&1
ec=$?
[ "$ec" -eq 2 ] && { echo "PASS: T6 missing dir exit 2"; PASS=$((PASS + 1)); } \
                || { echo "FAIL: T6 missing dir exit=$ec (want 2)"; FAIL=$((FAIL + 1)); }

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
