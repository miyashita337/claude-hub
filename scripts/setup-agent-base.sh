#!/bin/bash
set -e

# ローカルでは動かさない
[ "$CLAUDE_CODE_REMOTE" != "true" ] && exit 0

# 既にあればスキップ
[ -d "$HOME/agent-base" ] && exit 0

# clone（この時点では $GH_TOKEN が使える）
git clone "https://x-access-token:${GH_TOKEN}@github.com/miyashita337/agent-base.git" "$HOME/agent-base"

# ~/.claude/ に symlink
mkdir -p "$HOME/.claude"
for dir in commands skills agents hooks; do
  [ -d "$HOME/agent-base/$dir" ] && ln -sf "$HOME/agent-base/$dir" "$HOME/.claude/$dir"
done
[ -f "$HOME/agent-base/CLAUDE.md" ] && ln -sf "$HOME/agent-base/CLAUDE.md" "$HOME/.claude/CLAUDE.md"

exit 0
