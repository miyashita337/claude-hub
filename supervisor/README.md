# supervisor

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## session-ctl — ローカル介入 CLI（Epic #316 Phase 3 / #320）

オーケストレーター CC セッション（ローカル）が Supervisor 管理下のワーカーを
観測・介入するための薄い CLI。**sessions.db には一切書かない**（読み取り専用、
書き込みは Supervisor の専権）。

```bash
# cwd: ~/claude-hub
bun run supervisor/tools/session-ctl.ts list
bun run supervisor/tools/session-ctl.ts status <id>
bun run supervisor/tools/session-ctl.ts send <thread_id|session_id> <text...>
bun run supervisor/tools/session-ctl.ts stop <id>
bun run supervisor/tools/session-ctl.ts start-hub-worker <branch> <issueNumber> [selector]
```

- `<id>` は session row id / thread_id / claude_session_id のいずれでも可
- `send` は relay.ts の `sendToPane`（copy-mode 解除 → Escape → `send-keys -l` →
  C-m、argv-no-shell、専用 socket `-L claude-hub` = RW-019）を共有する
- `stop` は SIGTERM → 猶予 → `tmux kill-session`。sessions.db の status 反映は
  Supervisor の watcher が行い（~10s で `stopped` / `tmux_exited`）、worktree は
  保持される（RW-046 の共有 worktree 破壊は構造的に起こらない）。Supervisor
  停止中は次回起動時の `supervisor_restart` 整合に委ねる

### claude-hub work セッション経路（ADR-002 D5 / #208 案B）

`start-hub-worker` は Supervisor の relay サーバ（loopback-only）の
`POST /hub-work` を叩き、**CHANNEL_MAP を経由しない** ephemeral config で
`~/claude-hub` の branch worktree にワーカーセッションを起動する。

- ワーカースレッドは **corp チャンネル**配下に立つ（D5-3）
- `CHANNEL_MAP` に `claude-hub` は追加しない（`channels.ts` の FATAL guard 維持。
  ephemeral config の CHANNEL_MAP 登録も禁止）
- selector（`impl` / `no-template` / `pdca` / `article` / `devcycle`、省略時
  `impl`）は既存 `/dispatch` と同一の閉集合・同一の注入機構
- 並列上限・FIFO キューも既存 dispatch と同じ `DISPATCH_MAX_CONCURRENT` に従う
- ポート発見: relay サーバが起動時に runtime dir（`$XDG_RUNTIME_DIR/claude-hub-supervisor`
  または `/tmp/claude-hub-supervisor-$USER`）の `relay-port` へ実ポートを書く
- claudeHubExit（hijoguchi）の access policy / 機械ゲートには非干渉（復旧経路の
  独立性は不変。詳細は `docs/adr/2026-07-05-corp-orchestration.md` D5）

例（オーケストレーターが Issue #999 を pdca で投入）:

```bash
bun run supervisor/tools/session-ctl.ts start-hub-worker corp-dispatch-999 999 pdca
```
