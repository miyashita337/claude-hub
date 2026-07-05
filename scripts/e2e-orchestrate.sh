#!/usr/bin/env bash
# e2e-orchestrate.sh — Epic #316 Phase 4 (#321) の 1 コマンド E2E ランナー。
#
#   bash scripts/e2e-orchestrate.sh [--skip-live|--keep|--full|--brain-timeout-min N]
#
# 2 段構成:
#   1. S3 hermetic 回帰 — CI の「E2E Tests (AC-1..AC-7)」ジョブと同じスイート +
#      orchestrate / hub-work / dispatch のユニット（既存機能の非破壊を機械確認）
#   2. ライブ E2E — supervisor/tools/e2e-live.ts（実 Discord 駆動。前提と手動準備は
#      docs/e2e-orchestrate.md 参照）
#
# 終了コード: 全 PASS（SKIP 許容）で 0、いずれか FAIL で 1。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "== [1/2] S3 hermetic 回帰（既存機能の非破壊） =="
TMUX_BIN="${TMUX_PATH:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"

run_suite() {
  echo "--- bun test $* ---"
  (cd "$ROOT/supervisor" && SUPERVISOR_DB_PATH=":memory:" TMUX_PATH="$TMUX_BIN" bun test "$@")
}

# CI の e2e-tests ジョブと同一セット（AC-4..7 / relay / dialog-stall）
run_suite tests/e2e/ac-verification.test.ts tests/session/relay.test.ts tests/e2e/dialog-stall.test.ts

# session lifecycle（CI と同じ隔離 env。テスト専用 socket claude-hub-test = RW-019）
echo "--- bun test tests/e2e/session-lifecycle.test.ts (isolated) ---"
(cd "$ROOT/supervisor" && \
  SUPERVISOR_DB_PATH=":memory:" TMUX_PATH="$TMUX_BIN" \
  SUPERVISOR_TMUX_SOCKET=claude-hub-test \
  SUPERVISOR_CLAUDE_PATH="$ROOT/supervisor/tests/e2e/fixtures/claude-mock.sh" \
  bun test tests/e2e/session-lifecycle.test.ts)

# 本 Epic の対象経路（orchestrate / hub-work）+ 既存 dispatch の回帰ユニット
run_suite tests/session/orchestrate.test.ts
run_suite tests/session/hub-work.test.ts
run_suite tests/session/dispatch.test.ts tests/session/dispatch-queue.test.ts

echo
echo "== [2/2] ライブ E2E（実 Discord 駆動） =="
# .env は稼働中 Supervisor のもの（既定 ~/claude-hub/supervisor/.env）を使う。
# worktree から実行しても driver token を発見できるように fallback する。
ENV_FILE="${E2E_ENV_FILE:-$ROOT/supervisor/.env}"
if [ ! -f "$ENV_FILE" ]; then ENV_FILE="$HOME/claude-hub/supervisor/.env"; fi
exec bun --env-file="$ENV_FILE" "$ROOT/supervisor/tools/e2e-live.ts" "$@"
