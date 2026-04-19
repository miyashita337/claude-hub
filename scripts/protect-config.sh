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
  # Loopback-only allowlist. Anything else (public DNS, LAN IP, other schemes)
  # is treated as a relay-redirection attempt.
  if ! printf '%s' "${SUPERVISOR_RELAY_URL}" \
      | grep -qE '^(https?|wss?)://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/.*)?$'; then
    echo "[protect-config] BLOCKED: SUPERVISOR_RELAY_URL is not a loopback URL: ${SUPERVISOR_RELAY_URL}" >&2
    echo "[protect-config] Allowed schemes/hosts: (http|https|ws|wss)://(localhost|127.0.0.1|[::1])[:port][/path]" >&2
    exit 2
  fi
fi

# --- config-file protection (original behaviour) --------------------------

INPUT=$(cat)

if ! command -v jq &> /dev/null; then
  exit 0
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

# tsconfig.json: block disabling strict mode (new files still allowed)
if [ "${BASENAME}" = "tsconfig.json" ] && [ "${TOOL_NAME}" = "Edit" ]; then
  OLD_STRING=$(printf '%s' "${INPUT}" | jq -r '.tool_input.old_string // empty')
  if printf '%s' "${OLD_STRING}" | grep -qiE '"strict":\s*true'; then
    echo "[protect-config] BLOCKED: Disabling strict mode in tsconfig.json is not allowed." >&2
    exit 2
  fi
fi

# pyproject.toml: block edits to [tool.ruff*] sections
if [ "${BASENAME}" = "pyproject.toml" ] && [ "${TOOL_NAME}" = "Edit" ]; then
  OLD_STRING=$(printf '%s' "${INPUT}" | jq -r '.tool_input.old_string // empty')
  if printf '%s' "${OLD_STRING}" | grep -qiE '\[tool\.ruff'; then
    echo "[protect-config] BLOCKED: Modifying [tool.ruff] config in pyproject.toml is not allowed." >&2
    echo "[protect-config] Fix the code to satisfy ruff rules instead." >&2
    exit 2
  fi
fi

exit 0
