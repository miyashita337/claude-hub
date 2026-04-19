#!/bin/bash
# SessionStart hook 用 agent-base セットアップ。
# フック側で `&` を付けて非同期起動される想定。失敗は LOG_FILE に残す。
set -u

LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/setup-agent-base.log"
LOG_MAX_BYTES="${SETUP_AGENT_BASE_LOG_MAX_BYTES:-1048576}"   # 1 MiB
AGENT_BASE_DIR="$HOME/agent-base"
REPO_URL="https://github.com/miyashita337/agent-base.git"
CLONE_TIMEOUT_SEC="${SETUP_AGENT_BASE_CLONE_TIMEOUT:-60}"

mkdir -p "$LOG_DIR"
# ログローテーション: 閾値を超えたら .1 に退避して最新実行分だけ追記していく
if [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
  mv -f "$LOG_FILE" "${LOG_FILE}.1"
fi
# stdout/stderr を両方ログファイルに追記
exec >>"$LOG_FILE" 2>&1

log() { printf '[%s] [setup-agent-base] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "step: start (pid=$$)"

# ローカルでは動かさない（非リモートは skip ログだけ残して正常終了）
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  log "step: skip (CLAUDE_CODE_REMOTE != true)"
  exit 0
fi

# GH_TOKEN 未設定時は明示エラーにして終了
if [ -z "${GH_TOKEN:-}" ]; then
  log "ERROR: GH_TOKEN is not set; cannot clone agent-base"
  exit 1
fi

# エラー時にフック自体がセッションを中断しないようにし、ログに行番号を残す
trap 'rc=$?; log "ERROR: unexpected failure rc=$rc at line $LINENO"; exit $rc' ERR
set -e

# clone（未取得のときだけ）。
# GH_TOKEN は URL には含めず、`GIT_CONFIG_COUNT` で http.extraheader 経由で
# Basic 認証を渡す。こうすると:
#   - `ps` / /proc/PID/cmdline にトークンが載らない
#   - .git/config にも残らない（env は clone プロセス内でのみ有効）
if [ ! -d "$AGENT_BASE_DIR" ]; then
  log "step: clone (timeout=${CLONE_TIMEOUT_SEC}s)"
  auth_header="Authorization: Basic $(printf '%s' "x-access-token:${GH_TOKEN}" | base64 | tr -d '\n')"
  if command -v timeout >/dev/null 2>&1; then
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' \
      GIT_CONFIG_VALUE_0="$auth_header" \
      timeout "$CLONE_TIMEOUT_SEC" git clone --depth=1 "$REPO_URL" "$AGENT_BASE_DIR"
  else
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' \
      GIT_CONFIG_VALUE_0="$auth_header" \
      git clone --depth=1 "$REPO_URL" "$AGENT_BASE_DIR"
  fi
  unset auth_header
  log "step: clone done"
else
  log "step: clone skip (already present at $AGENT_BASE_DIR)"
fi

# ~/.claude/ に symlink を張る（clone スキップ時も毎回再生成して冪等）
log "step: symlink"
mkdir -p "$HOME/.claude"
for dir in commands skills agents hooks; do
  src="$AGENT_BASE_DIR/$dir"
  dst="$HOME/.claude/$dir"
  [ -d "$src" ] || continue
  # 既存が通常ディレクトリなら退避（ln -sf はディレクトリを置換せず内側に symlink を作ってしまう）
  # 同一秒内の多重実行で名前衝突しないよう PID を付加
  if [ -d "$dst" ] && [ ! -L "$dst" ]; then
    backup="${dst}.bak.$(date -u +%Y%m%d%H%M%S).$$"
    log "symlink: backup $dst -> $backup"
    mv "$dst" "$backup"
  fi
  ln -sfn "$src" "$dst"
done
if [ -f "$AGENT_BASE_DIR/CLAUDE.md" ]; then
  ln -sf "$AGENT_BASE_DIR/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
fi

log "step: done"
exit 0
