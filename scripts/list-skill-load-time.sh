#!/usr/bin/env bash
# list-skill-load-time.sh
#
# Measure Claude Code skill / agent / command asset count and metadata
# parse time across all marketplaces and project-local locations.
#
# Output is plain text + KEY: VALUE lines for downstream parsing. The
# critical lines required by Issue #106 AC-1 are:
#
#   total_skills: <N>
#   load_time_ms: <M>
#
# `load_time_ms` is a frontmatter parse benchmark used as a proxy for
# Claude Code's startup metadata load (we cannot directly instrument the
# CLI, so we measure the equivalent fs+parse work).
#
# Usage:
#   ./scripts/list-skill-load-time.sh                # human + machine readable
#   ./scripts/list-skill-load-time.sh --json         # JSON output (jq-friendly)
#   ./scripts/list-skill-load-time.sh --per-marketplace
#
# Exit:   0 = success, 1 = no skill sources found
# Issue:  https://github.com/miyashita337/claude-hub/issues/106
# Epic:   https://github.com/miyashita337/claude-hub/issues/101

set -euo pipefail

MODE="text"
SHOW_PER_MARKETPLACE=0
for arg in "$@"; do
    case "$arg" in
        --json) MODE="json" ;;
        --per-marketplace) SHOW_PER_MARKETPLACE=1 ;;
        -h|--help)
            sed -n '2,/^set -euo/p' "$0" | sed -n 's/^# \{0,1\}//p'
            exit 0
            ;;
    esac
done

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
PLUGINS_ROOT="$CLAUDE_DIR/plugins/marketplaces"
USER_SKILLS="$CLAUDE_DIR/skills"
USER_AGENTS="$CLAUDE_DIR/agents"
USER_COMMANDS="$CLAUDE_DIR/commands"

if [[ ! -d "$CLAUDE_DIR" ]]; then
    echo "ERROR: \$CLAUDE_DIR not found: $CLAUDE_DIR" >&2
    exit 1
fi

# Collect skill sources: each entry is "label|path"
SOURCES=()
[[ -d "$USER_SKILLS" ]]   && SOURCES+=("user|$USER_SKILLS")
if [[ -d "$PLUGINS_ROOT" ]]; then
    while IFS= read -r mp; do
        skills_dir="$mp/skills"
        [[ -d "$skills_dir" ]] && SOURCES+=("plugin:$(basename "$mp")|$skills_dir")
    done < <(find "$PLUGINS_ROOT" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
fi

if [[ ${#SOURCES[@]} -eq 0 ]]; then
    echo "ERROR: no skill source directories found under $CLAUDE_DIR" >&2
    exit 1
fi

# Per-source counts and frontmatter sizes
TOTAL_SKILLS=0
TOTAL_BYTES=0
PER_LINES=()
ALL_FRONTMATTER_FILES=()

for entry in "${SOURCES[@]}"; do
    label="${entry%%|*}"
    path="${entry##*|}"
    count=0
    bytes=0
    while IFS= read -r f; do
        count=$((count + 1))
        size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
        bytes=$((bytes + ${size:-0}))
        ALL_FRONTMATTER_FILES+=("$f")
    done < <(find "$path" -maxdepth 3 -name 'SKILL.md' 2>/dev/null)
    TOTAL_SKILLS=$((TOTAL_SKILLS + count))
    TOTAL_BYTES=$((TOTAL_BYTES + bytes))
    PER_LINES+=("$label|$count|$bytes|$path")
done

# Agents / commands count (counted once from canonical locations)
count_md() {
    local dir="$1"
    [[ -d "$dir" ]] || { echo 0; return; }
    find "$dir" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' '
}

USER_AGENT_COUNT=$(count_md "$USER_AGENTS")
USER_COMMAND_COUNT=$(count_md "$USER_COMMANDS")

PLUGIN_AGENT_COUNT=0
PLUGIN_COMMAND_COUNT=0
if [[ -d "$PLUGINS_ROOT" ]]; then
    while IFS= read -r mp; do
        [[ -d "$mp/agents" ]] && PLUGIN_AGENT_COUNT=$((PLUGIN_AGENT_COUNT + $(count_md "$mp/agents")))
        [[ -d "$mp/commands" ]] && PLUGIN_COMMAND_COUNT=$((PLUGIN_COMMAND_COUNT + $(count_md "$mp/commands")))
    done < <(find "$PLUGINS_ROOT" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
fi

TOTAL_AGENTS=$((USER_AGENT_COUNT + PLUGIN_AGENT_COUNT))
TOTAL_COMMANDS=$((USER_COMMAND_COUNT + PLUGIN_COMMAND_COUNT))

# Frontmatter parse benchmark (proxy for CC startup metadata load).
#
# Claude Code itself is implemented in a long-running runtime (single
# process), so a per-file shell fork would over-estimate the cost by
# orders of magnitude. We instead measure a single Python pass that
# reads every SKILL.md once and extracts the frontmatter block — this
# mirrors what an in-process parser does (fs read + YAML-ish split).
#
# A warm pre-pass primes the page cache so the timed pass reflects
# steady-state parse cost rather than first-touch IO.
PARSE_BENCH=$(printf '%s\n' "${ALL_FRONTMATTER_FILES[@]}" | python3 -c '
import sys, time

paths = [p for p in sys.stdin.read().splitlines() if p]

def parse_all():
    parsed = 0
    total_meta_bytes = 0
    for p in paths:
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            continue
        # extract between first two --- delimiters
        if data.startswith(b"---"):
            end = data.find(b"\n---", 3)
            if end != -1:
                total_meta_bytes += end
        parsed += 1
    return parsed, total_meta_bytes

# warm pass (discarded)
parse_all()

t0 = time.perf_counter_ns()
parsed, meta_bytes = parse_all()
t1 = time.perf_counter_ns()
print(f"{parsed} {meta_bytes} {(t1 - t0) // 1_000_000}")
')
PARSED=$(echo "$PARSE_BENCH" | awk '{print $1}')
META_BYTES=$(echo "$PARSE_BENCH" | awk '{print $2}')
LOAD_TIME_MS=$(echo "$PARSE_BENCH" | awk '{print $3}')

# Output
if [[ "$MODE" == "json" ]]; then
    printf '{"total_skills": %d, "total_agents": %d, "total_commands": %d, "total_frontmatter_bytes": %d, "frontmatter_meta_bytes": %d, "load_time_ms": %d, "parsed": %d, "sources": [' \
        "$TOTAL_SKILLS" "$TOTAL_AGENTS" "$TOTAL_COMMANDS" "$TOTAL_BYTES" "$META_BYTES" "$LOAD_TIME_MS" "$PARSED"
    first=1
    for line in "${PER_LINES[@]}"; do
        IFS='|' read -r label count bytes path <<<"$line"
        [[ $first -eq 0 ]] && printf ','
        printf '{"label": "%s", "skills": %d, "bytes": %d, "path": "%s"}' \
            "$label" "$count" "$bytes" "$path"
        first=0
    done
    printf ']}\n'
else
    echo "=== Claude Code skill / agent / command asset audit ==="
    echo "claude_dir       : $CLAUDE_DIR"
    echo "plugins_root     : $PLUGINS_ROOT"
    echo "total_skills: $TOTAL_SKILLS"
    echo "total_agents: $TOTAL_AGENTS"
    echo "total_commands: $TOTAL_COMMANDS"
    echo "total_frontmatter_bytes: $TOTAL_BYTES"
    echo "frontmatter_meta_bytes: $META_BYTES"
    echo "load_time_ms: $LOAD_TIME_MS"
    echo "parsed_skills: $PARSED"
    if [[ $SHOW_PER_MARKETPLACE -eq 1 ]]; then
        echo
        echo "=== Per-source breakdown ==="
        printf '%-50s %8s %12s\n' "label" "skills" "bytes"
        for line in "${PER_LINES[@]}"; do
            IFS='|' read -r label count bytes path <<<"$line"
            printf '%-50s %8d %12d\n' "$label" "$count" "$bytes"
        done
    fi
fi
