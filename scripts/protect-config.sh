#!/bin/bash
# Linter/Formatter config protection hook (PreToolUse).
#
# Responsibilities:
#   1. Reject env-var bypass attempts (S8 #54 / Epic #45) — fail-closed.
#   2. Block Write/Edit of tracked linter/formatter config files so agents fix
#      the code instead of weakening the rules.
#
# Env guards (run BEFORE reading stdin so malformed/empty input can't bypass):
#   - CLAUDE_SKIP_PROTECT : presence is rejected regardless of value.
#   - SUPERVISOR_RELAY_URL: only loopback (localhost / 127.0.0.1 / [::1]) with
#     http|https|ws|wss scheme is allowed; any other host is blocked.
#
# Variable refs use ${VAR} form (RW-006: avoid $VAR adjacent to non-ASCII bytes).

set -euo pipefail

# --- env-var guards (S8 #54) ----------------------------------------------

if [ -n "${CLAUDE_SKIP_PROTECT:-}" ]; then
  echo "[protect-config] BLOCKED: CLAUDE_SKIP_PROTECT bypass is rejected." >&2
  echo "[protect-config] Fix the underlying rule/config issue instead of disabling this hook." >&2
  exit 2
fi

if [ -n "${SUPERVISOR_RELAY_URL:-}" ]; then
  # Loopback-only allowlist. The optional trailing segment accepts any of
  # "/path", "?query", or "#fragment" so valid localhost URLs with query
  # parameters (e.g. `http://localhost:3000?token=x`) are not rejected.
  # Anything else (public DNS, LAN IP, other schemes) is treated as a
  # relay-redirection attempt.
  if ! printf '%s' "${SUPERVISOR_RELAY_URL}" \
      | grep -qE '^(https?|wss?)://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?([/?#].*)?$'; then
    echo "[protect-config] BLOCKED: SUPERVISOR_RELAY_URL is not a loopback URL: ${SUPERVISOR_RELAY_URL}" >&2
    echo "[protect-config] Allowed: (http|https|ws|wss)://(localhost|127.0.0.1|[::1])[:port][/path|?query|#frag]" >&2
    exit 2
  fi
fi

# --- config-file protection -----------------------------------------------

INPUT=$(cat)

# Empty stdin: nothing to inspect. Treat as pass-through so manual `bash
# scripts/protect-config.sh` with no input (e.g. env-guard-only invocations)
# doesn't trip jq on older versions that error on empty input.
if [ -z "${INPUT}" ]; then
  exit 0
fi

# jq is required to parse hook input. Fail-closed (exit 2) rather than
# fail-open (exit 0) so a missing dependency can't silently disable protection
# for the tracked linter/formatter config files.
if ! command -v jq &> /dev/null; then
  echo "[protect-config] BLOCKED: jq is required but not found on PATH." >&2
  echo "[protect-config] Install jq (e.g. 'brew install jq') to use this hook." >&2
  exit 2
fi

TOOL_NAME=$(printf '%s' "${INPUT}" | jq -r '.tool_name // empty')

if [ "${TOOL_NAME}" != "Write" ] && [ "${TOOL_NAME}" != "Edit" ]; then
  exit 0
fi

FILE_PATH=$(printf '%s' "${INPUT}" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')

if [ -z "${FILE_PATH}" ]; then
  exit 0
fi

BASENAME=$(basename "${FILE_PATH}")

PROTECTED_FILES=(
  "biome.json"
  "biome.jsonc"
  ".eslintrc"
  ".eslintrc.js"
  ".eslintrc.cjs"
  ".eslintrc.json"
  ".eslintrc.yml"
  "eslint.config.js"
  "eslint.config.mjs"
  "eslint.config.ts"
  ".prettierrc"
  ".prettierrc.js"
  ".prettierrc.json"
  ".prettierrc.yml"
  "commitlint.config.js"
  "commitlint.config.ts"
  "ruff.toml"
  "clippy.toml"
  ".rustfmt.toml"
)

for protected in "${PROTECTED_FILES[@]}"; do
  if [ "${BASENAME}" = "${protected}" ]; then
    echo "[protect-config] BLOCKED: ${BASENAME} is a protected linter/formatter config." >&2
    echo "[protect-config] Fix the code to satisfy the rules, don't weaken the rules." >&2
    exit 2
  fi
done

# tsconfig.json guards.
#   Edit : block if `old_string` contains `"strict": true` — the edit is
#          removing/replacing the strict flag, i.e. disabling strict mode.
#   Write: block any full-file rewrite. Whether the new content keeps or drops
#          `strict` can't be judged without reading the existing file; blocking
#          the rewrite entirely is the conservative choice. Legitimate tweaks
#          should go through Edit, which keeps the strict-removal guard intact.
if [ "${BASENAME}" = "tsconfig.json" ]; then
  case "${TOOL_NAME}" in
    Edit)
      OLD_STRING=$(printf '%s' "${INPUT}" | jq -r '.tool_input.old_string // empty')
      if printf '%s' "${OLD_STRING}" | grep -qiE '"strict":[[:space:]]*true'; then
        echo "[protect-config] BLOCKED: Disabling strict mode in tsconfig.json is not allowed." >&2
        exit 2
      fi
      ;;
    Write)
      echo "[protect-config] BLOCKED: Full rewrite of tsconfig.json is not allowed." >&2
      echo "[protect-config] Use Edit for scoped changes so the strict-mode guard can evaluate the diff." >&2
      exit 2
      ;;
  esac
fi

# pyproject.toml guards.
#   Edit : block if `old_string` contains `[tool.ruff` — modifying ruff config.
#   Write: block if `content` contains `[tool.ruff` — new file declares ruff
#          config (could be adding, removing, or modifying it). Conservative
#          but keeps the "don't touch ruff config via this hook" invariant.
if [ "${BASENAME}" = "pyproject.toml" ]; then
  case "${TOOL_NAME}" in
    Edit)
      PAYLOAD=$(printf '%s' "${INPUT}" | jq -r '.tool_input.old_string // empty')
      ;;
    Write)
      PAYLOAD=$(printf '%s' "${INPUT}" | jq -r '.tool_input.content // empty')
      ;;
    *)
      PAYLOAD=''
      ;;
  esac
  if printf '%s' "${PAYLOAD}" | grep -qiE '\[tool\.ruff'; then
    echo "[protect-config] BLOCKED: Modifying [tool.ruff] config in pyproject.toml is not allowed." >&2
    echo "[protect-config] Fix the code to satisfy ruff rules instead." >&2
    exit 2
  fi
fi

exit 0
