#!/usr/bin/env bun
/**
 * verify-folder-trust — 実機で「フォルダ信頼の確認画面を承認して入力待ちまで進む」ことを確かめる
 * (Issue #571 / #569)。
 *
 * #569 の承認処理（{@link folderTrustAcceptKeys}）はユニットテストでしか確かめられていなかった。
 * 本ツールは毎回新しく作る一時フォルダ（= 必ず未信頼）で本物の Claude Code を起動し、
 * 実際の画面に対して承認キーを送り、入力待ちマーカーが出るまでを見る。CI には claude が
 * 無いので bun test ではなく、この Mac で手動実行する実機ツールにしている。
 *
 * 本番の Supervisor と干渉しないよう、tmux は専用 socket（{@link SOCKET}）で動かす。
 * Supervisor と同じく tmux の既定サイズ（80 桁）で起動するので、80 桁を超える長いパスの
 * 折り返しも本番と同じ条件で確かめられる。
 *
 * 副作用: 承認した一時フォルダの信頼情報が ~/.claude.json に 1 件ずつ残る（Claude Code 自身が
 * 書く。動作中の他セッションと書き込みが競合するため、本ツールからは消さない）。
 *
 * 使い方（repo root から）: bun supervisor/tools/verify-folder-trust.ts
 * exit 0 = 全ケース PASS / 1 = いずれか FAIL
 */

import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SOCKET = "claude-hub-trust-verify";
// tmux.ts reads the socket at import time, so set it before the dynamic import.
process.env.SUPERVISOR_TMUX_SOCKET = SOCKET;
const { realTmuxAdapter: tmux } = await import("../src/session/adapters");
const { folderTrustAcceptKeys, INPUT_READY_RE } = await import("../src/session/manager");

/**
 * Production sessions run with `--dangerously-skip-permissions`, whose footer
 * matches {@link INPUT_READY_RE} (`bypass permissions`). This tool launches
 * claude without that flag, so the footer shows the user's default mode
 * instead (measured: `⏵⏵ auto mode on (shift+tab to cycle)`). Both mean the
 * TUI is ready for input; the trust dialog appears either way.
 */
const isInputReady = (pane: string) =>
  INPUT_READY_RE.test(pane) || /⏵⏵ .+ on \(shift\+tab to cycle\)/.test(pane);

const POLL_MS = 500;
const TIMEOUT_MS = 60_000;

interface Case {
  name: string;
  /** Extra path segment that makes the folder path long enough to wrap at 80 columns. */
  suffix: string;
}

const CASES: Case[] = [
  { name: "short-path", suffix: "" },
  { name: "long-path (>80 cols)", suffix: "worktrees/" + "x".repeat(70) },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCase(c: Case, index: number): Promise<boolean> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "trust-verify-")));
  const dir = c.suffix ? join(base, c.suffix) : base;
  mkdirSync(dir, { recursive: true });
  // pid makes the name unique per run, so two concurrent runs on the shared
  // socket never collide or kill each other's session in `finally` (PR #572 review).
  const session = `trust-verify-${process.pid}-${index}`;
  const log = (msg: string) => console.log(`[${c.name}] ${msg}`);
  log(`folder (${dir.length} chars): ${dir}`);

  let lastPane = "";
  try {
    await tmux.newSession(
      session,
      `unset ANTHROPIC_API_KEY && cd "${dir}" && exec claude --strict-mcp-config --mcp-config '{"mcpServers":{}}'`
    );
    let accepted = false;
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await tmux.hasSession(session))) {
        log("FAIL: Claude Code exited before becoming ready");
        break;
      }
      lastPane = await tmux.capturePane(session);
      if (isInputReady(lastPane)) {
        if (!accepted) {
          log("FAIL: input-ready without a trust dialog (folder was already trusted?)");
          return false;
        }
        log("input-ready marker seen → PASS");
        return true;
      }
      const keys = folderTrustAcceptKeys(lastPane, dir);
      if (keys && !accepted) {
        log(`trust dialog detected → sending ${keys.join(" ")}`);
        await tmux.sendKeys(session, keys);
        accepted = true;
      }
      await sleep(POLL_MS);
    }
    log(`FAIL: ${accepted ? "not ready after accepting" : "trust dialog never matched"} within ${TIMEOUT_MS}ms`);
    console.log(`----- last pane (${c.name}) -----\n${lastPane}\n-----`);
    return false;
  } finally {
    await tmux.killSession(session);
    rmSync(base, { recursive: true, force: true });
  }
}

let allPass = true;
for (const [i, c] of CASES.entries()) {
  const ok = await runCase(c, i);
  allPass &&= ok;
}
console.log(allPass ? "PASS: all cases" : "FAIL: see above");
process.exit(allPass ? 0 : 1);
