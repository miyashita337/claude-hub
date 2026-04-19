#!/bin/bash
set -e

# ローカルでは動かさない
[ "$CLAUDE_CODE_REMOTE" != "true" ] && exit 0

AGENT_BASE_DIR="$HOME/agent-base"
REPO_URL="https://github.com/miyashita337/agent-base.git"

# clone（未取得のときだけ）。GH_TOKEN が .git/config に残らないよう clone 直後に URL を差し替える
if [ ! -d "$AGENT_BASE_DIR" ]; then
  git clone "https://x-access-token:${GH_TOKEN}@github.com/miyashita337/agent-base.git" "$AGENT_BASE_DIR"
  git -C "$AGENT_BASE_DIR" remote set-url origin "$REPO_URL"
fi

# ~/.claude/ に symlink を張る（clone スキップ時も毎回再生成して冪等）
mkdir -p "$HOME/.claude"
for dir in commands skills agents hooks; do
  src="$AGENT_BASE_DIR/$dir"
  dst="$HOME/.claude/$dir"
  [ -d "$src" ] || continue
  # 既存が通常ディレクトリなら退避（ln -sf はディレクトリを置換せず内側に symlink を作ってしまう）
  if [ -d "$dst" ] && [ ! -L "$dst" ]; then
    mv "$dst" "${dst}.bak.$(date +%Y%m%d%H%M%S)"
  fi
  ln -sfn "$src" "$dst"
done
if [ -f "$AGENT_BASE_DIR/CLAUDE.md" ]; then
  ln -sf "$AGENT_BASE_DIR/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
fi

exit 0
