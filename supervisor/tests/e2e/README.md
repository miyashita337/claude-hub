# E2E Verification — AC-1..AC-7

End-to-end verification of the `Discord → Supervisor → tmux → Claude Code → Supervisor → Discord` relay chain, defined during the [Issue #73](https://github.com/miyashita337/claude-hub/issues/73) session.

Run locally:

    cd supervisor
    TMUX_PATH=/opt/homebrew/bin/tmux bun test tests/e2e/ac-verification.test.ts

Run in CI: see the `E2E Tests (AC-1..AC-7)` job in `.github/workflows/ci.yml`. It installs `tmux` on `ubuntu-latest` and executes this file plus `tests/session/relay.test.ts`.

## AC matrix

| AC | What it verifies | Runnable in CI | File / Test ID |
|----|------------------|-----------------|----------------|
| AC-1 | `/session start` slash command accepted | **No** — requires live Discord bot token | `ac-verification.test.ts` (skipped with rationale) |
| AC-2 | New Discord thread created | **No** — requires Discord | `ac-verification.test.ts` (skipped) |
| AC-3 | Supervisor posts startup message | **No** — requires Discord | `ac-verification.test.ts` (skipped) |
| AC-4 | tmux session naming follows `claude-<threadId12>` | **Yes** | `AC-4`, `AC-4b` |
| AC-5 | Mock Claude inside tmux receives typed input | **Yes** (bash stub stands in for Claude CLI) | `AC-5` |
| AC-6 | Supervisor relay-server receives Stop-hook POST | **Yes** (HTTP loopback) | `AC-6` |
| AC-7 | Relay delivers hyphen + Japanese + period payload verbatim | **Yes** | `AC-7`, `AC-7b` |

## Manual verification for AC-1/2/3

After merging a change that could affect the Discord path (any edit under `supervisor/src/` that touches `bot.ts`, `commands/`, or `session/manager.ts`), run the following against a live Supervisor:

1. `launchctl kickstart -k "gui/$UID/com.claude-hub.supervisor"` to pick up the new build.
2. In any registered Discord channel (e.g. `#team-salary`), run `/session start`.
3. **AC-1** — the slash command is acknowledged (no `Unknown interaction` error).
4. **AC-2** — a new thread named `Session: <channel>` is created.
5. **AC-3** — the thread contains a `Channel-Supervisor` message with directory / session count / `/session stop` instructions.
6. Send a message containing a hyphen and Japanese (e.g. `ping - 起動不能調査.`) and confirm Claude's response is relayed back (covers AC-4/5/6/7 in the real stack).

Track the outcome in the PR description's *Test plan* checklist.

## Why AC-7 keeps its own sub-cases

AC-7b reproduces the exact regression seen on 2026-04-23 (Issue #73): pane stuck in copy-mode from a prior wheel-scroll, then a retry hit `not in a mode` and silently dropped the Discord message. The test leaves the pane in copy-mode before sending, which is the condition existing unit tests did not reproduce.

If AC-7 or AC-7b starts to fail, **do not skip or weaken the test** — investigate whether `ensurePaneNotInMode` is still being called before `tmuxSend`, and whether tmux's `not in a mode` handling changed. Record findings under a new `RW-XXX` entry in `agent-base/rules/general/rework-patterns.md`.
