---
date: 2026-10-11
status: accepted
decision_makers: owner（corp CEO セッション 2026-10-04 の AgentTeam 協議: architect / devils-advocate / security-reviewer）
related_issue: https://github.com/miyashita337/claude-hub/issues/492
---

# ADR-003: claude を外部 launcher（ccorg proxy）経由で起動できるようにする

## Status

**Accepted**（実装は既定 off。段階導入は Issue #492 の表に従う）

## Context

5h 上限に達したとき、セッションを止めずに別 org へ切り替えたい。miyashita337/claude-org の `ccorg proxy` は、ローカル proxy を立てて `ANTHROPIC_BASE_URL` を向け、`claude` を子プロセスとして起動する。

`SUPERVISOR_CLAUDE_PATH` にラッパー script を指す方式でも動くが、次が黙って壊れるため採用しない:

- `ResourceMonitor` は `session.pid` の RSS を測る。ラッパー経由だと pid が node（proxy）になり、メモリ上限ガードが claude を測らなくなる
- headless の `onSpawn` pid も node になる

## Decision

`SUPERVISOR_CLAUDE_LAUNCHER`（例: `ccorg proxy`）を追加する（`supervisor/src/session/launcher.ts`）。

- 設定時、tmux start / tmux resume / headless の 3 箇所で **claude バイナリの代わりに launcher を exec する**（argv は同一）。`ccorg proxy` は `claude` を PATH から自分で探すため、`SUPERVISOR_CLAUDE_PATH` は launcher 下では使われない
- `SUPERVISOR_CLAUDE_LAUNCHER_SCOPE`（カンマ区切り: `all` / `dispatch` / `channel:<name>`、未設定は `all`）で段階導入する。rollback は launcher を unset して supervisor を再起動（起動中のセッションは kill しない）
- `session.pid` は launcher の子孫のうち実行ファイル名が `claude` のものに解決する。launcher の pid は `session.launcherPid`（メモリのみ）に持つ。解決できないときは warn して launcher の pid を追跡する
- `ResourceMonitor` は `launcherPid` があるとき、launcher を根とするプロセスツリー全体（proxy + claude + 子）の RSS 合計で判定する。launcher なしの挙動は変えない
- `stop()` は launcher → claude の順に SIGTERM を送る
- proxy の stderr バナー（`-> proxy 127.0.0.1:<port> (... log: <path>)`）から log パスを `session.proxyLogPath` に記録する（tmux は pane 取得、headless は stderr 受信）。headless の失敗理由（stderr tail）からはバナー行を除く
- proxy が全 org 不可のとき返す 503 本文（`all orgs rate-limited or unreachable`）を新しい dialog kind `all-orgs-limit` として検知し、usage-limit と同じ経路（Discord + Pushover）で通知する。headless は実行後に Pushover を送る

## Consequences

- supervisor が外部 CLI（claude-org）に依存する。launcher が起動しない場合は tmux 側で `tmux_exited` として既存経路が拾う
- `session.pid` の意味が「launcher 下では claude 本体」になる。`launcherPid` は再起動をまたいで復元しない（復元後は claude のみの RSS 判定になる）
- **前提**: claude-org#22（シグナル転送）を含む版が必要。2026-10-11 時点で `/opt/homebrew/bin/ccorg` のグローバル版はシグナル転送が無く、launcher に SIGTERM を送ると claude が孤児化した（claude-org main では解消を実測）。supervisor は launcher と claude の両方へ SIGTERM を送るため孤児は残らないが、導入前に ccorg を更新すること
- 範囲外: supervisor を経由しない claude 起動（agent-base 側スクリプト）、`mcp-hourly-check.sh`（connector MCP 検証のため proxy 化しない）
