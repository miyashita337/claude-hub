#!/bin/bash
# PermissionRequest hook: Supervisorヘッドレスセッションでは自動承認
# SUPERVISOR_RELAY_URL が設定されている場合のみ有効（通常セッションには影響しない）

if [ -z "$SUPERVISOR_RELAY_URL" ]; then
  exit 0
fi

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.command // "N/A"' | head -c 120)

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] tool=$TOOL target=$FILE" >> /tmp/supervisor-permissions.log

jq -n '{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}'
