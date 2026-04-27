# CLAUDE.md (claude-hub)

このファイルは `claude-hub` プロジェクト固有の規約を **薄いリンク集** として記述する。
global rules (`~/agent-base/rules/`) で済むものは書かない。重複は禁止。

## プロジェクト概要

Discord Bot 経由で Claude Code セッションを管理する Supervisor システム。
詳細は [`docs/bot-operations.md`](./docs/bot-operations.md) を参照。

## 絶対ルール

`docs/bot-operations.md` 由来の不可侵ルールを以下に列挙する。違反は実装前に必ずユーザー確認すること。

- **Channel-Supervisor の `CHANNEL_MAP` に `claude-hub` を追加してはいけない**
  - 理由: Supervisor がクラッシュした際の復旧経路（claudeHubExit）を独立に保つため
  - 関連: [`supervisor/src/config/channels.ts`](./supervisor/src/config/channels.ts)
- **claudeHubExit は他 Bot のスレッドに割り込まない**
  - 非 primary channel は `requireMention=true` + `allowFrom=[owner]` を維持する
  - 詳細: `docs/bot-operations.md` の Access Policy セクション
- **Supervisor 専用 tmux socket (`-L claude-hub`) を必ず使う**
  - user の `~/.tmux.conf` を継承すると mouse/copy-mode 関連で send-keys が silent drop する
  - 関連 RW: RW-019 (`~/agent-base/rules/general/rework-patterns.md`)

## アーキテクチャ前提

- **Runtime**: Bun（Node.js ではない）
- **Discord**: discord.js v14、1 トークン 1 Gateway 接続
- **プロセス**: tmux + launchd（macOS LaunchAgents）
- **DB**: SQLite (`bun:sqlite`)、WAL モード必須
- ドメイン知識の詳細: [`.claude/rules/domain-expert.md`](./.claude/rules/domain-expert.md)

## 既存資産へのリンク

| 種類 | 場所 |
|---|---|
| Bot 運用方針（絶対ルール / Access Policy / Permission Mode） | [`docs/bot-operations.md`](./docs/bot-operations.md) |
| ドメイン知識（技術スタック / レビュー観点） | [`.claude/rules/domain-expert.md`](./.claude/rules/domain-expert.md) |
| Supervisor 設定 | [`.claude/settings.json`](./.claude/settings.json), [`.claude/settings.local.json`](./.claude/settings.local.json) |
| プロジェクトメモリ | ~/.claude/projects/ 配下のプロジェクトパスに対応するディレクトリ |
| 既知の手戻りパターン (RW-019 等) | `~/agent-base/rules/general/rework-patterns.md` |

## global rules との関係

本ファイルは `~/agent-base/rules/general/` の上書きや補足を**目的としない**。
以下の事項は global rules を参照すること。重複記述は禁止する。

- Git / GitHub Issues / PR 規約: `~/agent-base/rules/general/git-conventions.md`, `pr-size.md`
- 自律実行・AgentTeams: `~/agent-base/rules/general/autonomous-decision.md`, `agent-teams.md`
- 受け入れ基準 / 統合ジャーニーAC: `~/agent-base/rules/general/acceptance-criteria.md`, `journey-ac.md`
- セキュリティ / fact-checking: `~/agent-base/rules/general/security.md`, `fact-checking.md`
- 再発防止 / RW 記録: `~/agent-base/rules/general/rework-prevention.md`, `rework-patterns.md`
