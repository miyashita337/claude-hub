#!/usr/bin/env bun
/**
 * session-ctl — Supervisor 管理セッションへのローカル介入 CLI
 * (Epic #316 Phase 3 / #320)。
 *
 * オーケストレーター CC セッション（ローカル）がワーカーセッションを
 * 観測・介入するための薄い CLI。設計原則:
 *
 *   - **sessions.db は読み取り専用**（`bun:sqlite` の `{ readonly: true }`、
 *     WAL モード前提）。DB への書き込みは Supervisor の専権であり、この CLI は
 *     一切書かない。`stop` 後の status 反映も Supervisor の watchTmuxSession
 *     （10s poll → status='stopped' reason='tmux_exited'）に委ねる。
 *   - **send は relay.ts の {@link sendToPane} を共有**: copy-mode 解除 →
 *     Escape → `send-keys -l`（argv-no-shell）→ C-m の実績経路（Issue #73 /
 *     #32 / #33）をそのまま使う。tmux は Supervisor 専用 socket
 *     `-L claude-hub`（RW-019、relay.ts の既定 TMUX_ARGS）。
 *   - **stop は worktree を壊さない**（RW-046）: tmux kill 経由の停止は
 *     Supervisor 側で `tmux_exited` として処理され、worktree は意図的に
 *     残される（manager.ts watchTmuxSession のコメント参照）。共有 worktree の
 *     破壊（isWorktreePathInUse で守られる /session stop 経路）はそもそも
 *     通らない。
 *   - **start-hub-worker は Supervisor の `POST /hub-work`**（loopback-only、
 *     ADR-002 D5 の claude-hub work セッション経路）を叩く。ポートは
 *     relay-server が書く runtime-dir のポートファイルから発見する。
 *
 * 使い方（cwd: ~/claude-hub）:
 *   bun run supervisor/tools/session-ctl.ts list
 *   bun run supervisor/tools/session-ctl.ts status <id>
 *   bun run supervisor/tools/session-ctl.ts send <thread_id|session_id> <text...>
 *   bun run supervisor/tools/session-ctl.ts stop <id>
 *   bun run supervisor/tools/session-ctl.ts start-hub-worker <branch> <issueNumber> [selector]
 *   bun run supervisor/tools/session-ctl.ts post-channel <thread_id> <text...>
 *
 * `<id>` は session row id / thread_id / claude_session_id のいずれでも可。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Database } from "bun:sqlite";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveDbPath, type SessionRow } from "../src/infra/db";
import { SessionManager } from "../src/session/manager";
import { sendToPane } from "../src/session/relay";
import { TMUX_PATH, TMUX_ARGS } from "../src/session/tmux";
import { relayPortFilePath } from "../src/session/relay-server";
import { GRACEFUL_KILL_TIMEOUT_MS } from "../src/config/channels";

const execFileAsync = promisify(execFile);

/** sessions.db への読み取り専用アクセス面（テストは fake を注入する）。 */
export interface SessionStore {
  listRunning(): SessionRow[];
  /** id / thread_id / claude_session_id のいずれかで最新 1 行（status 不問）。 */
  findByKey(key: string): SessionRow | undefined;
  /** 同上、ただし status='running' のみ。 */
  findRunningByKey(key: string): SessionRow | undefined;
}

/** 副作用アダプタ（テストは fake を注入する。実体は {@link createRealEffects}）。 */
export interface SessionCtlEffects {
  store: SessionStore;
  /**
   * relay.ts sendToPane 相当（copy-mode 解除 → Escape → -l → C-m、-L claude-hub）。
   *
   * 戻り値が `unknown` なのは意図的: sendToPane は #422 以降 配達 verdict を返すが、
   * ここは注入した内容を待たない fire-and-forget 経路なので判定を使わない。void と
   * 偽らずに広げておく（fake 実装は今までどおり何も返さなくてよい）。
   */
  sendText(tmuxSessionName: string, text: string): Promise<unknown>;
  hasTmuxSession(tmuxSessionName: string): Promise<boolean>;
  killTmuxSession(tmuxSessionName: string): Promise<void>;
  /** process.kill 相当。配達できたら true。 */
  killPid(pid: number, signal: NodeJS.Signals): boolean;
  pidAlive(pid: number): boolean;
  /**
   * pid の実行中コマンドライン（`ps -p <pid> -o command=` 相当）。プロセスが
   * 居なければ null。headless セッションの本人確認に使う（Issue #358）。
   */
  readPidCommand(pid: number): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  /** relay ポートファイルから Supervisor の relay ポートを読む（無ければ null）。 */
  readRelayPort(): number | null;
  /**
   * relay-port が無いときの復旧（#400）。同じ runtime dir の `*.relay-url` から
   * ポートを取り出し、実際に relay サーバが応答するものだけを返す（死んだ URL は
   * 使わない）。見つからなければ null。
   */
  recoverRelayPort(): Promise<number | null>;
  /** 復旧したポートで relay-port を書き直す（best-effort。失敗しても投稿は続ける）。 */
  writeRelayPort(port: number): void;
  /** この runtime dir を使う Supervisor プロセスが居るか（エラー文言の出し分け用）。 */
  supervisorRunning(): Promise<boolean>;
  httpPost(
    url: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }>;
  out(line: string): void;
  err(line: string): void;
}

export interface SessionCtlOptions {
  /** stop: SIGTERM 後 tmux kill までの猶予（既定 GRACEFUL_KILL_TIMEOUT_MS）。 */
  graceMs?: number;
  /** stop: Supervisor による status 反映を待つ上限（既定 30s）。 */
  statusWaitMs?: number;
  /** stop: status 反映のポーリング間隔（既定 2s）。 */
  statusPollMs?: number;
}

export const USAGE = `session-ctl — Supervisor 管理セッションのローカル介入 CLI (#320)

使い方 (cwd: ~/claude-hub):
  bun run supervisor/tools/session-ctl.ts <subcommand> ...

subcommands:
  list
      running セッション一覧 (sessions.db 読み取り専用)
  status <id>
      セッション詳細 + liveness。<id> は session_id / thread_id / claude_session_id
  send <thread_id|session_id> <text...>
      ワーカーの tmux ペインへテキスト送信 (argv-no-shell / -L claude-hub, RW-019)
  stop <id>
      SIGTERM → 猶予 → tmux kill-session。sessions.db への status 反映は
      Supervisor の watcher が行う (この CLI は DB に書かない)。worktree は保持 (RW-046)
  start-hub-worker <branch> <issueNumber> [selector]
      claude-hub work セッションを corp チャンネル配下に起動 (POST /hub-work, ADR-002 D5)。
      selector: impl / no-template / pdca / article / devcycle (省略時 impl)
  post-channel <thread_id> <text...>
      スレッドの親チャンネル直下へテキスト投稿 (POST /channel-post, #339)。
      オーケストレーターの進捗・最終レポートを corp チャンネル直下へ届ける用途`;

/** threadId → tmux セッション名（Supervisor と同一の公式マッピングを共有）。 */
export function tmuxNameForThread(threadId: string): string {
  return SessionManager.tmuxSessionNameFor(threadId);
}

function fmtRow(row: SessionRow): string {
  return [
    `id=${row.id}`,
    `channel=${row.channel_name}`,
    `thread=${row.thread_id ?? "-"}`,
    `branch=${row.branch ?? "-"}`,
    `status=${row.status}`,
    `started=${row.started_at}`,
    `last_activity=${row.last_activity_at}`,
    `dir=${row.project_dir}`,
  ].join("\t");
}

async function cmdList(fx: SessionCtlEffects): Promise<number> {
  const rows = fx.store.listRunning();
  if (rows.length === 0) {
    fx.out("(running セッションなし)");
    return 0;
  }
  for (const row of rows) fx.out(fmtRow(row));
  fx.out(`計 ${rows.length} 件 (status=running)`);
  return 0;
}

async function cmdStatus(fx: SessionCtlEffects, key: string): Promise<number> {
  const row = fx.store.findByKey(key);
  if (!row) {
    fx.err(`セッションが見つかりません: ${key}`);
    return 1;
  }
  fx.out(fmtRow(row));
  fx.out(`claude_session_id=${row.claude_session_id ?? "-"}`);
  fx.out(`pid=${row.pid ?? "-"}`);
  fx.out(`stopped_reason=${row.stopped_reason ?? "-"}`);
  if (row.thread_id) {
    const tmuxName = tmuxNameForThread(row.thread_id);
    const tmuxAlive = await fx.hasTmuxSession(tmuxName);
    const pidAlive = row.pid != null ? fx.pidAlive(row.pid) : false;
    // manager.livenessOf と同じ判定規則: DB running + pid alive + tmux alive。
    const liveness =
      row.status === "running" && pidAlive && tmuxAlive ? "alive" : "dead";
    fx.out(`tmux=${tmuxName} (alive=${tmuxAlive})`);
    fx.out(`pid_alive=${pidAlive}`);
    fx.out(`liveness=${liveness}`);
  } else {
    fx.out("tmux=- (thread_id なし)");
  }
  return 0;
}

async function cmdSend(
  fx: SessionCtlEffects,
  key: string,
  text: string,
): Promise<number> {
  if (!text.trim()) {
    fx.err("送信テキストが空です。");
    return 1;
  }
  const row = fx.store.findRunningByKey(key);
  if (!row) {
    fx.err(`running セッションが見つかりません: ${key}`);
    return 1;
  }
  if (!row.thread_id) {
    fx.err(`セッション ${row.id} に thread_id が記録されていません（送信不可）。`);
    return 1;
  }
  const tmuxName = tmuxNameForThread(row.thread_id);
  if (!(await fx.hasTmuxSession(tmuxName))) {
    fx.err(
      `tmux セッション ${tmuxName} が存在しません（セッションは既に終了している可能性）。`,
    );
    return 1;
  }
  await fx.sendText(tmuxName, text);
  fx.out(`✅ ${tmuxName} (thread ${row.thread_id}) へ送信しました (${text.length} chars)`);
  return 0;
}

/**
 * tmux を持たない headless ワーカーを pid 経由で停止する（Issue #358、案 A）。
 *
 * 本人確認は `ps` のコマンドラインに当該セッションの `claude_session_id`（UUID）が
 * 含まれるかで行う。これが PID 再利用ガードの代替:
 *
 *   - UUID 不一致 → OS が pid を別プロセスへ再利用している（or そもそも別物）
 *     → **何もしない**。無関係プロセスを殺さないことを最優先する
 *   - 一致 → 紛れもなく当該ワーカー → SIGTERM → 猶予 → まだ生きていれば SIGKILL
 *
 * 戻り値で「殺さなかった理由」を呼び出し側に伝え、メッセージを出し分ける
 * （どちらのスキップも silent にしない = agent-output-quality #1）。
 * sessions.db には書かない（書き込みは Supervisor の専権）。
 */
type HeadlessStopOutcome =
  /** 本人確認が取れてシグナルを送った（メッセージは本関数が出力済み）。 */
  | "signalled"
  /** pid は生存しているがコマンドラインが一致しない = PID 再利用の疑い。 */
  | "identity-mismatch"
  /** pid 不明 / session id 未記録 / 既に終了 — headless 停止の対象外。 */
  | "not-applicable";

async function stopHeadlessByPid(
  fx: SessionCtlEffects,
  row: SessionRow,
  graceMs: number,
): Promise<HeadlessStopOutcome> {
  const pid = row.pid;
  const claudeSessionId = row.claude_session_id;
  if (pid == null || !claudeSessionId) return "not-applicable";
  if (!fx.pidAlive(pid)) return "not-applicable";

  const command = await fx.readPidCommand(pid);
  // ps が読めない場合も一致とは見なさない（安全側 = 殺さない）。
  if (!command || !command.includes(claudeSessionId)) return "identity-mismatch";

  fx.out(
    `tmux 不在（headless）。pid ${pid} のコマンドラインで session id を確認したため SIGTERM を送信します。`,
  );
  fx.killPid(pid, "SIGTERM");
  if (graceMs > 0) await fx.sleep(graceMs);

  if (fx.pidAlive(pid)) {
    fx.killPid(pid, "SIGKILL");
    fx.out(
      `猶予 ${graceMs}ms 経過後も生存していたため SIGKILL を送信しました（pid ${pid}）。`,
    );
  } else {
    fx.out(`pid ${pid} は SIGTERM で終了しました。`);
  }
  return "signalled";
}

async function cmdStop(
  fx: SessionCtlEffects,
  key: string,
  opts: SessionCtlOptions,
): Promise<number> {
  const row = fx.store.findRunningByKey(key);
  if (!row) {
    fx.err(`running セッションが見つかりません: ${key}`);
    return 1;
  }
  const graceMs = opts.graceMs ?? GRACEFUL_KILL_TIMEOUT_MS;
  const statusWaitMs = opts.statusWaitMs ?? 30_000;
  const statusPollMs = opts.statusPollMs ?? 2_000;

  // Supervisor の stop() と同じ順序（SIGTERM → 猶予 → tmux kill）。ただし
  // sessions.db には書かず（書き込みは Supervisor の専権）、worktree にも
  // 触れない: tmux セッション消滅を Supervisor の watchTmuxSession が検知し、
  // status='stopped' (tmux_exited) へ更新する。tmux_exited 経路は worktree を
  // 意図的に残すので、共有 worktree の破壊（RW-046）は構造的に起こらない。
  //
  // PID 再利用ガード（PR #325 gemini high）: DB の pid は Supervisor 停止中や
  // 長時間経過後に OS が別プロセスへ再利用している可能性がある。tmux セッション
  // の生存を確認できた場合のみシグナルを送る（tmux が消えていれば元プロセスも
  // 終了済みの可能性が極めて高く、送ると無関係プロセスを殺すリスクだけが残る）。
  const tmuxName = row.thread_id ? tmuxNameForThread(row.thread_id) : null;
  const tmuxAlive = tmuxName ? await fx.hasTmuxSession(tmuxName) : false;

  if (!tmuxAlive) {
    // Issue #358: headless（`claude -p`）ワーカーは tmux を持たない。上の
    // ガードは「tmux が無い = もう死んでいる」と見なすため、headless では
    // SIGTERM がスキップされ、プロセスが生きたまま「停止した」ように見えていた。
    // 暴走ワーカーを止める最後の手段が効かず、記事投稿・SNS 連携のような不可逆な
    // 外部副作用を伴うタスクで特に危険（2026-08-01 の誤 dispatch で実際に踏んだ）。
    //
    // PID 再利用ガードの意図は保つ: tmux の代わりに **コマンドラインが当該
    // セッションのものか** を照合する。headless argv には必ず
    // `--session-id <uuid>` が入る（manager.ts buildHeadlessClaudeFlags 直後で
    // 付与）ので、UUID 一致は事実上衝突しない本人確認になる。
    const outcome = await stopHeadlessByPid(fx, row, graceMs);
    if (outcome === "identity-mismatch") {
      fx.out(
        `pid ${row.pid} は生存していますが、コマンドラインに session id ${row.claude_session_id} を含みません。` +
          "SIGTERM / kill をスキップします（PID 再利用による誤 kill 防止）。",
      );
    } else if (outcome === "not-applicable") {
      fx.out(
        `tmux セッション${tmuxName ? ` ${tmuxName}` : ""} が存在しないため SIGTERM / kill をスキップします` +
          "（PID 再利用による誤 kill 防止。Supervisor が status を整合します）。",
      );
    }
  } else {
    if (row.pid != null) {
      const delivered = fx.killPid(row.pid, "SIGTERM");
      fx.out(
        delivered
          ? `SIGTERM を pid ${row.pid} へ送信しました（graceful 停止待ち ${graceMs}ms）`
          : `pid ${row.pid} は既に終了しています`,
      );
      if (graceMs > 0) await fx.sleep(graceMs);
    }
    await fx.killTmuxSession(tmuxName!);
    fx.out(`tmux セッション ${tmuxName} を kill しました（worktree は保持されます）`);
  }

  // Supervisor watcher (10s poll) による status 反映を確認する（読み取りのみ）。
  let waited = 0;
  while (waited < statusWaitMs) {
    const latest = fx.store.findByKey(row.id);
    if (latest && latest.status !== "running") {
      fx.out(
        `✅ sessions.db 反映確認: status=${latest.status} (reason=${latest.stopped_reason ?? "-"})`,
      );
      return 0;
    }
    await fx.sleep(statusPollMs);
    waited += statusPollMs;
  }
  fx.out(
    "⚠️ sessions.db の status がまだ running のままです。Supervisor が停止中の可能性があります" +
      "（Supervisor 再起動時に supervisor_restart として整合されます）。",
  );
  return 0;
}

/**
 * relay ポートを解決する（#400）。順序: relay-port → relay-url 復旧 → エラー。
 * 失敗時のメッセージは「Supervisor 稼働中で探索ファイルだけ失われた」と
 * 「Supervisor 未起動」を区別する（稼働中なのに未起動と誤診させない）。
 */
async function resolveRelayPort(
  fx: SessionCtlEffects,
): Promise<{ port: number } | { error: string }> {
  const direct = fx.readRelayPort();
  if (direct != null) return { port: direct };
  const recovered = await fx.recoverRelayPort();
  if (recovered != null) {
    fx.out(
      `⚠️ relay-port が無いため relay-url から relay ポート ${recovered} を復旧しました（応答確認済み）。`,
    );
    fx.writeRelayPort(recovered);
    return { port: recovered };
  }
  if (await fx.supervisorRunning()) {
    return {
      error:
        "relay-port（ポートファイル）が失われていますが Supervisor プロセスは稼働中です。" +
        "relay-url からの復旧にも失敗しました（稼働中セッションが無い可能性）。" +
        "Supervisor を再起動するか、稼働中の relay ポートで relay-port を手動作成してください。",
    };
  }
  return {
    error:
      "Supervisor が起動していません（relay-port なし・応答する relay-url なし）。" +
      "Supervisor を起動してください。",
  };
}

async function cmdStartHubWorker(
  fx: SessionCtlEffects,
  branch: string,
  issueArg: string,
  selector?: string,
): Promise<number> {
  if (!/^[0-9]+$/.test(issueArg)) {
    fx.err("issueNumber は正の整数で指定してください。");
    return 1;
  }
  const issueNumber = Number(issueArg);
  const resolved = await resolveRelayPort(fx);
  if ("error" in resolved) {
    fx.err(resolved.error);
    return 1;
  }
  const port = resolved.port;
  const payload: Record<string, unknown> = { branch, issueNumber };
  if (selector !== undefined) payload.selector = selector;
  let res: { status: number; body: unknown };
  try {
    res = await fx.httpPost(`http://127.0.0.1:${port}/hub-work`, payload);
  } catch (err) {
    fx.err(
      `Supervisor への接続に失敗しました (port ${port}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const body = (res.body ?? {}) as Record<string, unknown>;
  if (res.status === 200 && body.ok === true) {
    fx.out(
      `✅ claude-hub work セッションを受け付けました: thread=${String(body.threadId)} ` +
        `queued=${String(body.queued)} injected=${String(body.injected)}`,
    );
    return 0;
  }
  fx.err(
    `❌ hub work 起動に失敗しました (HTTP ${res.status}): ${typeof body.error === "string" ? body.error : JSON.stringify(res.body)}`,
  );
  return 1;
}

async function cmdPostChannel(
  fx: SessionCtlEffects,
  threadId: string,
  text: string,
): Promise<number> {
  // Discord thread ID は snowflake（数値列）。書式で早期に弾いて、Supervisor
  // への無駄な往復と紛らわしい 404 を避ける。
  if (!/^[0-9]+$/.test(threadId)) {
    fx.err(`thread_id は Discord スレッド ID（数値列）で指定してください: ${threadId}`);
    return 1;
  }
  if (!text.trim()) {
    fx.err("投稿テキストが空です。");
    return 1;
  }
  const resolved = await resolveRelayPort(fx);
  if ("error" in resolved) {
    fx.err(resolved.error);
    return 1;
  }
  const port = resolved.port;
  let res: { status: number; body: unknown };
  try {
    res = await fx.httpPost(
      `http://127.0.0.1:${port}/channel-post/${encodeURIComponent(threadId)}`,
      { text },
    );
  } catch (err) {
    fx.err(
      `Supervisor への接続に失敗しました (port ${port}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const body = (res.body ?? {}) as Record<string, unknown>;
  if (res.status === 200 && body.ok === true) {
    fx.out(
      `✅ スレッド ${threadId} の親チャンネル (${String(body.channelId)}) へ投稿しました ` +
        `(${String(body.chunks)} chunks)`,
    );
    return 0;
  }
  fx.err(
    `❌ チャンネル投稿に失敗しました (HTTP ${res.status}): ${typeof body.error === "string" ? body.error : JSON.stringify(res.body)}`,
  );
  return 1;
}

/**
 * CLI エントリ本体（純粋オーケストレーション）。argv はサブコマンド以降
 * （`process.argv.slice(2)` 相当）。テストは fake effects を注入して呼ぶ。
 */
export async function runSessionCtl(
  argv: string[],
  fx: SessionCtlEffects,
  opts: SessionCtlOptions = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list":
      return cmdList(fx);
    case "status": {
      if (rest.length !== 1 || !rest[0]) {
        fx.err("使い方: session-ctl status <id>");
        return 1;
      }
      return cmdStatus(fx, rest[0]);
    }
    case "send": {
      const [key, ...words] = rest;
      if (!key || words.length === 0) {
        fx.err("使い方: session-ctl send <thread_id|session_id> <text...>");
        return 1;
      }
      return cmdSend(fx, key, words.join(" "));
    }
    case "stop": {
      if (rest.length !== 1 || !rest[0]) {
        fx.err("使い方: session-ctl stop <id>");
        return 1;
      }
      return cmdStop(fx, rest[0], opts);
    }
    case "start-hub-worker": {
      const [branch, issueArg, selector, ...extra] = rest;
      if (!branch || !issueArg || extra.length > 0) {
        fx.err(
          "使い方: session-ctl start-hub-worker <branch> <issueNumber> [selector]",
        );
        return 1;
      }
      return cmdStartHubWorker(fx, branch, issueArg, selector);
    }
    case "post-channel": {
      const [threadId, ...words] = rest;
      if (!threadId || words.length === 0) {
        fx.err("使い方: session-ctl post-channel <thread_id> <text...>");
        return 1;
      }
      return cmdPostChannel(fx, threadId, words.join(" "));
    }
    case "help":
    case "--help":
    case "-h":
      fx.out(USAGE);
      return 0;
    default:
      fx.err(USAGE);
      return 1;
  }
}

/** 実 DB（読み取り専用）+ 実 tmux + 実 HTTP のアダプタを組み立てる。 */
/** relay サーバが本当にそのポートで応答するか（GET /health/sessions が 200 + 期待形）。 */
export async function probeRelay(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/sessions`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.status !== 200) return false;
    const body = (await res.json().catch(() => null)) as {
      count?: unknown;
      max?: unknown;
      sessions?: unknown;
    } | null;
    // 別サービスが偶然同ポートを使っていても誤認しないよう、relay 固有の形（count/max/sessions）を要求する
    return (
      typeof body?.count === "number" &&
      typeof body?.max === "number" &&
      Array.isArray(body?.sessions)
    );
  } catch {
    return false;
  }
}

/**
 * runtime dir の `*.relay-url`（`http://localhost:<port>/relay/<thread>`）から
 * 応答する relay ポートを探す（#400）。mtime の新しい順に試し、最初に応答したものを返す。
 */
export async function recoverRelayPortFromRelayUrls(
  runtimeDir: string,
  probe: (port: number) => Promise<boolean> = probeRelay,
): Promise<number | null> {
  let names: string[];
  try {
    names = readdirSync(runtimeDir)
      .filter((n) => n.endsWith(".relay-url"))
      .map((n) => ({ n, t: statSync(join(runtimeDir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((x) => x.n);
  } catch {
    return null;
  }
  const ports: number[] = [];
  for (const name of names) {
    try {
      const m = readFileSync(join(runtimeDir, name), "utf8").match(
        /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//,
      );
      const port = m ? Number(m[1]) : NaN;
      if (Number.isSafeInteger(port) && port > 0 && !ports.includes(port)) {
        ports.push(port);
      }
    } catch {
      // 読めない relay-url は候補から外す
    }
  }
  for (const port of ports) {
    if (await probe(port)) return port;
  }
  return null;
}

/**
 * 同じ runtime dir（XDG_RUNTIME_DIR）を使う Supervisor プロセスが居るか。
 * `supervisor/index.ts` を実行中のプロセスのうち、環境変数 XDG_RUNTIME_DIR が
 * 呼び出し側と一致するものだけを数える（隔離 Supervisor と本番を取り違えない）。
 */
async function isSupervisorRunning(xdg: string | undefined): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-f", "supervisor/index.ts"], {
      timeout: 5000,
    });
    const pids = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const pid of pids) {
      try {
        const { stdout: env } = await execFileAsync(
          "/bin/ps",
          ["eww", "-p", pid, "-o", "command="],
          { timeout: 5000 },
        );
        const m = env.match(/(?:^|\s)XDG_RUNTIME_DIR=(\S+)/);
        if ((m ? m[1] : undefined) === (xdg || undefined)) return true;
      } catch {
        // プロセスが途中で消えた
      }
    }
    return false;
  } catch {
    // pgrep は 1 件も無いと exit 1
    return false;
  }
}

export function createRealEffects(): SessionCtlEffects {
  let db: Database | null = null;
  const getReadonlyDb = (): Database => {
    if (!db) {
      const path = resolveDbPath();
      if (path !== ":memory:" && !existsSync(path)) {
        throw new Error(
          `sessions.db が見つかりません: ${path}（Supervisor 未初期化の可能性）`,
        );
      }
      // 読み取り専用で開く（WAL 前提で Supervisor の書き込みと共存できる）。
      // create しない・書かない = 「書き込みは Supervisor の専権」の機械的担保。
      db = new Database(path, { readonly: true });
    }
    return db;
  };

  const store: SessionStore = {
    listRunning: () =>
      getReadonlyDb()
        .prepare(
          `SELECT * FROM sessions WHERE status = 'running' ORDER BY started_at`,
        )
        .all() as SessionRow[],
    findByKey: (key) =>
      getReadonlyDb()
        .prepare(
          `SELECT * FROM sessions
           WHERE id = ? OR thread_id = ? OR claude_session_id = ?
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(key, key, key) as SessionRow | undefined,
    findRunningByKey: (key) =>
      getReadonlyDb()
        .prepare(
          `SELECT * FROM sessions
           WHERE status = 'running' AND (id = ? OR thread_id = ? OR claude_session_id = ?)
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(key, key, key) as SessionRow | undefined,
  };

  return {
    store,
    // relay.ts の実績送信経路を共有（既定 TMUX_ARGS = -L claude-hub、RW-019）。
    sendText: (tmuxName, text) => sendToPane(tmuxName, text),
    hasTmuxSession: async (name) => {
      try {
        await execFileAsync(
          TMUX_PATH,
          [...TMUX_ARGS, "has-session", "-t", name],
          { timeout: 5000 },
        );
        return true;
      } catch {
        return false;
      }
    },
    killTmuxSession: async (name) => {
      try {
        await execFileAsync(
          TMUX_PATH,
          [...TMUX_ARGS, "kill-session", "-t", name],
          { timeout: 5000 },
        );
      } catch {
        // 既に消えている場合は成功扱い（冪等）。
      }
    },
    killPid: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
    readPidCommand: async (pid) => {
      // `ps -p <pid> -o command=` は macOS / Linux 共通で full argv を返す
      // （`=` でヘッダ抑止）。argv 配列で渡すので shell は介さない。
      // プロセス不在なら ps は非 0 で終わる → null（呼び出し側は kill しない）。
      try {
        const { stdout } = await execFileAsync(
          "/bin/ps",
          ["-p", String(pid), "-o", "command="],
          { timeout: 5000 },
        );
        const line = stdout.trim();
        return line || null;
      } catch {
        return null;
      }
    },
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readRelayPort: () => {
      try {
        const raw = readFileSync(relayPortFilePath(), "utf8");
        const port = Number(raw.trim());
        return Number.isSafeInteger(port) && port > 0 ? port : null;
      } catch {
        return null;
      }
    },
    recoverRelayPort: async () => recoverRelayPortFromRelayUrls(dirname(relayPortFilePath())),
    writeRelayPort: (port) => {
      try {
        // flag "wx": 復旧中に Supervisor が再起動して新しい relay-port を書いていたら上書きしない
        writeFileSync(relayPortFilePath(), String(port), { flag: "wx" });
      } catch {
        // best-effort: 書けなくても（既に存在する場合を含む）今回の投稿は復旧したポートで続行できる
      }
    },
    supervisorRunning: () => isSupervisorRunning(process.env.XDG_RUNTIME_DIR),
    httpPost: async (url, body) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, body: json };
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

if (import.meta.main) {
  runSessionCtl(process.argv.slice(2), createRealEffects())
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
