#!/usr/bin/env bash
# audit-team-salary-logs.sh
#
# Audit logs/sessions/team-salary_* for leakage of claudeHubExit context
# and other cross-project secrets (Discord tokens, API keys, internal paths).
#
# Usage:  ./scripts/audit-team-salary-logs.sh
# Exit:   0 = no leak detected, 1 = leak detected (and quarantined)
# Issue:  https://github.com/miyashita337/claude-hub/issues/50

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${REPO_ROOT}/logs/sessions"
QUARANTINE_DIR="${LOG_DIR}/quarantine"
ISSUE_URL="https://github.com/miyashita337/claude-hub/issues/50"

shopt -s nullglob
targets=( "${LOG_DIR}"/team-salary_*.log )
shopt -u nullglob

echo "=== team-salary log audit ==="
echo "scan root : ${LOG_DIR}"
echo "issue     : ${ISSUE_URL}"

if [[ ${#targets[@]} -eq 0 ]]; then
    echo "target    : 0 files"
    echo "result    : PASS (no files to audit)"
    exit 0
fi

first_date=""
last_date=""
total_bytes=0
for f in "${targets[@]}"; do
    base="$(basename "$f")"
    date_part="${base#team-salary_}"
    date_part="${date_part%%T*}"
    if [[ -z "$first_date" || "$date_part" < "$first_date" ]]; then first_date="$date_part"; fi
    if [[ -z "$last_date"  || "$date_part" > "$last_date"  ]]; then last_date="$date_part"; fi
    size=$(wc -c <"$f" | tr -d ' ')
    total_bytes=$((total_bytes + size))
done
echo "target    : ${#targets[@]} files, ${total_bytes} bytes, ${first_date} .. ${last_date}"

PATTERNS=(
    'claudeHubExit'
    'hijoguchi'
    'hijoguchi-system-prompt'
    'DISCORD_BOT_TOKEN[=: ]'
    'Authorization:[[:space:]]*Bearer'
    'sk-ant-[A-Za-z0-9_-]{10,}'
    'ghp_[A-Za-z0-9]{20,}'
    'ghs_[A-Za-z0-9]{20,}'
    '[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}'
    'team-salary/src/'
    'team-salary/secrets/'
    'team-salary/.env'
)

hit_count=0
hit_files=()
declare -a hit_lines

# Build a single multi-pattern grep invocation (one pass per file) to avoid
# N_files * N_patterns subprocess overhead.
grep_args=()
for pat in "${PATTERNS[@]}"; do
    grep_args+=("-e" "$pat")
done

for f in "${targets[@]}"; do
    file_hit=0
    # grep -o emits only the matching substring, keeping the line number prefix
    # from -n but dropping the full line content. This prevents secrets (Discord
    # tokens, API keys, Authorization headers) from leaking into CI build logs
    # when the audit FAILs — reviewers need to look at the quarantined file.
    while IFS= read -r match; do
        lineno="${match%%:*}"
        hit_count=$((hit_count + 1))
        hit_lines+=("$(basename "$f"):${lineno}")
        file_hit=1
    done < <(grep -noE "${grep_args[@]}" "$f" 2>/dev/null || true)
    if [[ $file_hit -eq 1 ]]; then
        hit_files+=("$f")
    fi
done

if [[ $hit_count -eq 0 ]]; then
    echo "patterns  : ${#PATTERNS[@]} checked"
    echo "hits      : 0"
    echo "result    : PASS (no leakage detected)"
    exit 0
fi

echo "patterns  : ${#PATTERNS[@]} checked"
echo "hits      : ${hit_count} across ${#hit_files[@]} files"
echo "result    : FAIL — see ${ISSUE_URL}"
echo ""
echo "--- detected (filename:lineno only, content redacted) ---"
for ref in "${hit_lines[@]}"; do
    echo "$ref" >&2
done
echo "inspect the quarantined file directly for details." >&2

mkdir -p "$QUARANTINE_DIR"
for f in "${hit_files[@]}"; do
    dest="${QUARANTINE_DIR}/$(basename "$f")"
    mv "$f" "$dest"
    echo "quarantined: $(basename "$f") -> quarantine/" >&2
done

exit 1
