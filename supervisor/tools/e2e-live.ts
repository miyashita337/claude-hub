#!/usr/bin/env bun
/**
 * e2e-live — 実 Discord 駆動の /orchestrate E2E + 既存経路回帰ドライバ
 * (Epic #316 Phase 4 / Issue #321)。
 *
 * テストドライバ Bot（Supervisor とは別の、owner 保有の未使用 Bot token）が
 * Discord REST で corp チャンネルへ `/orchestrate` メッセージを投稿し、
 * Supervisor の応答（スレッド生成 / welcome / 案内 / エラー）と sessions.db
 * （read-only）・GitHub 状態を決定的にアサートする。
 *
 * 設計上の前提（コードとの契約。変更時は本ドライバも同期すること）:
 *   - `/orchestrate` は bot ドロップより前にインターセプトされ、認可は
 *     access.json `allowFrom`（corp は requireMention:false）。よって driver
 *     Bot の id を corp グループの allowFrom に加えるだけで駆動できる
 *     （bot.ts handleOrchestrateMessage）。thread relay は `message.author.bot`
 *     で落ちるため、この許可でドライバが通常セッションを操作できるようには
 *     **ならない**（widening は /orchestrate 起動のみ）。
 *   - 空引数 fail-closed は Supervisor 層（⚠️ 引数が空です）。存在しない .tmp
 *     の fail-closed は **スキル層**（ADR-002 D2: Supervisor は引数を解釈しない）。
 *     Issue #321 S2 の「セッション未起動」は空引数にのみ適用される。
 *   - claude-hub work 経路（S1b）は session-ctl start-hub-worker（POST
 *     /hub-work、PR #325）を直接叩く（モデル非依存の決定的検証）。
 *
 * 課金・外部影響ガード:
 *   - テスト Issue はタイトル先頭 `[e2e-test]` + 「実装せずコメントのみ」指示。
 *   - Pushover / SNS を発火させる経路は本ドライバに存在しない（Discord REST と
 *     sessions.db 読み取りと gh のみ）。
 *   - 終了時に cleanup（セッション stop / Issue close / worktree・branch 削除 /
 *     スレッド archive / .tmp 削除）。--keep で残す（デバッグ用）。
 *
 * 使い方（repo root から。wrapper: scripts/e2e-orchestrate.sh）:
 *   bun --env-file=supervisor/.env supervisor/tools/e2e-live.ts [flags]
 *
 * flags:
 *   --skip-live        ライブ手順をすべてスキップ（hermetic 回帰のみ = CI 安全）
 *   --keep             cleanup をスキップ（残骸をデバッグ用に残す）
 *   --full             S1 で最終レポート到達まで待つ（Phase 5 受け入れ実走向け）
 *   --brain-timeout-min <n>  S1 のオーケストレーター頭脳検証の上限（既定 20）
 *
 * S2-4（error loop）/ S2-5（kill→resume 再入）はモデル挙動依存 + 長時間のため
 * 本ドライバでは SKIP として明示レポートし、Phase 5（#322）の受け入れ実走で検証する。
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { runSessionCtl, createRealEffects } from "./session-ctl";
import { relayPortFilePath } from "../src/session/relay-server";
import { resolveDbPath } from "../src/infra/db";

const API = "https://discord.com/api/v10";

// ---------- 設定（env 上書き可） ----------
const DRIVER_TOKEN_ENV = process.env.E2E_DRIVER_TOKEN_ENV ?? "VIDEO_QA_BOT_TOKEN";
const CORP_CHANNEL_NAME = process.env.E2E_CORP_CHANNEL_NAME ?? "corp";
const REPO = process.env.E2E_REPO ?? "miyashita337/claude-hub";
/** hijoguchi（claudeHubExit）Bot の user id。非干渉アサート用（S1b/S3）。 */
const HIJOGUCHI_BOT_ID = process.env.E2E_HIJOGUCHI_BOT_ID ?? "1487717424173416538";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const argVal = (f: string, d: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const SKIP_LIVE = has("--skip-live");
const KEEP = has("--keep");
const FULL = has("--full");
const BRAIN_TIMEOUT_MS = Number(argVal("--brain-timeout-min", "20")) * 60_000;

// ---------- 結果集計 ----------
type Verdict = "PASS" | "FAIL" | "SKIP";
interface Result { id: string; name: string; verdict: Verdict; evidence: string }
const results: Result[] = [];
function record(id: string, name: string, verdict: Verdict, evidence: string) {
  results.push({ id, name, verdict, evidence });
  const mark = verdict === "PASS" ? "✅" : verdict === "SKIP" ? "⏭️" : "❌";
  console.log(`${mark} [${id}] ${name} — ${evidence}`);
}

// ---------- 汎用ヘルパ ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 10_000,
): Promise<T | null> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

function gh(ghArgs: string[]): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["gh", ...ghArgs], { env: { ...process.env, GH_REPO: REPO } });
  return {
    ok: p.exitCode === 0,
    stdout: new TextDecoder().decode(p.stdout).trim(),
    stderr: new TextDecoder().decode(p.stderr).trim(),
  };
}

// ---------- Discord REST（driver Bot） ----------
const driverToken = process.env[DRIVER_TOKEN_ENV] ?? "";
const H = { Authorization: `Bot ${driverToken}`, "Content-Type": "application/json" };

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  // 429 は素直に待って 1 回だけ再試行（polling 前提なので深追いしない）
  if (res.status === 429 && json?.retry_after) {
    await sleep(Math.ceil(json.retry_after * 1000) + 250);
    return rest(method, path, body);
  }
  return { status: res.status, json };
}

async function postMessage(channelId: string, content: string): Promise<string> {
  const r = await rest("POST", `/channels/${channelId}/messages`, { content });
  if (r.status !== 200) throw new Error(`postMessage failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.id as string;
}

/** after 指定 message id より新しいメッセージ（古い→新しい順で返す）。 */
async function fetchMessagesAfter(channelId: string, afterId: string): Promise<any[]> {
  const r = await rest("GET", `/channels/${channelId}/messages?after=${afterId}&limit=100`);
  if (r.status !== 200) return [];
  return (r.json as any[]).reverse();
}

async function fetchAllMessages(channelId: string, limit = 100): Promise<any[]> {
  const r = await rest("GET", `/channels/${channelId}/messages?limit=${limit}`);
  return r.status === 200 ? (r.json as any[]).reverse() : [];
}

// ---------- sessions.db（read-only） ----------
function dbRows(sql: string, ...params: string[]): any[] {
  const path = resolveDbPath();
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as any[];
  } finally {
    db.close();
  }
}
const runningByBranchPrefix = (prefix: string) =>
  dbRows(`SELECT * FROM sessions WHERE status='running' AND branch LIKE ? ORDER BY started_at`, `${prefix}%`);
const rowsSince = (isoT0: string) =>
  dbRows(`SELECT * FROM sessions WHERE started_at > ? ORDER BY started_at`, isoT0);

// ---------- cleanup 対象の記録 ----------
const createdIssues: number[] = [];
const createdSessionKeys: string[] = []; // session row id
const createdBranches: { repoDir: string; branch: string }[] = [];
const createdThreads: string[] = [];
const createdTmpFiles: string[] = [];

async function stopSessionQuiet(key: string): Promise<void> {
  try {
    await runSessionCtl(["stop", key], createRealEffects(), { statusWaitMs: 45_000 });
  } catch (err) {
    console.warn(`cleanup: stop ${key} failed: ${err}`);
  }
}

// ============================================================
async function main(): Promise<number> {
  console.log(`== e2e-live (Issue #321) ${new Date().toISOString()} ==`);

  if (SKIP_LIVE) {
    record("LIVE", "ライブ手順（プリフライト含む）", "SKIP", "--skip-live 指定（hermetic 回帰のみ）");
    return finish();
  }

  // ---------- プリフライト ----------
  if (!driverToken) {
    record("PRE", "driver Bot token", "FAIL", `env ${DRIVER_TOKEN_ENV} が空`);
    return finish();
  }
  const me = await rest("GET", "/users/@me");
  if (me.status !== 200) {
    record("PRE", "driver Bot token", "FAIL", `users/@me HTTP ${me.status}`);
    return finish();
  }
  const driverBotId = me.json.id as string;

  const guilds = await rest("GET", "/users/@me/guilds");
  const guildId = guilds.json?.[0]?.id;
  const chans = await rest("GET", `/guilds/${guildId}/channels`);
  const corp = (chans.json as any[]).find((c) => c.name === CORP_CHANNEL_NAME && c.type === 0);
  if (!corp) {
    record("PRE", "corp チャンネル発見", "FAIL", `guild ${guildId} に #${CORP_CHANNEL_NAME} なし`);
    return finish();
  }
  const corpId = corp.id as string;

  // access.json: corp allowFrom に driver Bot id（/orchestrate 認可）。
  // これは owner が明示的に行う手動準備（docs/e2e-orchestrate.md 前提 3）であり、
  // 本ドライバは access.json を**書き換えない**（読み取り検査のみ）。未許可なら
  // /orchestrate 駆動シナリオ（S1 / S2-*）を SKIP し、認可不要の S1b / S3 のみ実行する。
  let orchestrateDriveAuthorized = false;
  const accessPath = join(homedir(), ".claude", "channels", "discord", "access.json");
  try {
    const policy = JSON.parse(readFileSync(accessPath, "utf8"));
    const allow: string[] = policy?.groups?.[corpId]?.allowFrom ?? [];
    orchestrateDriveAuthorized = allow.includes(driverBotId);
  } catch { /* fail-closed: 未認可扱い */ }

  // Supervisor が PR #325 以降のコードで稼働しているか（/hub-work が 400 を返す = 新コード）
  let relayPort: number | null = null;
  try {
    relayPort = Number(readFileSync(relayPortFilePath(), "utf8").trim()) || null;
  } catch { /* fallthrough */ }
  if (relayPort == null) {
    record("PRE", "Supervisor relay port", "FAIL",
      "ポートファイルなし（Supervisor 未起動、または PR #325 より前のコードで稼働中 → docs/e2e-orchestrate.md 前提 1 の再起動が必要）");
    return finish();
  }
  try {
    const probe = await fetch(`http://127.0.0.1:${relayPort}/hub-work`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (probe.status !== 400) {
      record("PRE", "/hub-work エンドポイント", "FAIL",
        `HTTP ${probe.status}（400 期待）。Supervisor が PR #325 以降のコードで再起動されていない可能性`);
      return finish();
    }
  } catch (err) {
    record("PRE", "/hub-work エンドポイント", "FAIL", String(err));
    return finish();
  }

  // orchestrate-runner スキル（S1 頭脳）が install 済みか
  const skillPath = join(homedir(), ".claude", "skills", "orchestrate-runner", "SKILL.md");
  if (!existsSync(skillPath)) {
    record("PRE", "orchestrate-runner スキル", "FAIL", `${skillPath} なし（agent-base install 未実施）`);
    return finish();
  }
  record("PRE", "プリフライト", "PASS",
    `driver=${me.json.username}(${driverBotId}) corp=${corpId} relayPort=${relayPort}`);

  const hijoguchiPidBefore = Bun.spawnSync(["pgrep", "-f", "CLAUDE_HUB_HIJOGUCHI_SESSION=1"]).stdout.toString().trim();
  const t0iso = new Date().toISOString();

  const AUTH_SKIP =
    "corp allowFrom に driver Bot 未登録のため /orchestrate 駆動不可（手動準備 3 = docs/e2e-orchestrate.md。owner が access.json を編集後に再実行）";

  // ---------- S2-1: 空引数 → Supervisor 層 fail-closed（セッション未起動） ----------
  if (!orchestrateDriveAuthorized) {
    record("S2-1", "空引数 fail-closed（セッション未起動）", "SKIP", AUTH_SKIP);
  } else {
    const before = runningByBranchPrefix("orchestrate-").length;
    const msgId = await postMessage(corpId, "/orchestrate");
    const warn = await pollUntil(async () => {
      const msgs = await fetchMessagesAfter(corpId, msgId);
      return msgs.find((m) => m.content?.includes("引数が空です")) ?? null;
    }, 60_000, 5_000);
    const after = runningByBranchPrefix("orchestrate-").length;
    if (warn && after === before) {
      record("S2-1", "空引数 fail-closed（セッション未起動）", "PASS", "⚠️ 応答あり + orchestrate-* 増加なし");
    } else {
      record("S2-1", "空引数 fail-closed（セッション未起動）", "FAIL",
        `warn=${!!warn} sessions ${before}→${after}`);
    }
  }

  // ---------- S2-3: 存在しない .tmp → スキル層 fail-closed（ワーカー未投入） ----------
  // ADR-002 D2 により Supervisor は引数を解釈しない = セッション自体は起動する（設計どおり）。
  // アサート: 起動後、スキルがエラーを報告し、ワーカー/Issue を作らないこと。
  let orchA: any = null;
  if (!orchestrateDriveAuthorized) {
    record("S2-3", "存在しない .tmp（スキル層 fail-closed）", "SKIP", AUTH_SKIP);
  } else {
    const bogus = `~/.claude/sessions/e2e-nonexistent-${Date.now()}.tmp`;
    const issuesBefore = countE2eIssues();
    await postMessage(corpId, `/orchestrate ${bogus}`);
    orchA = await pollUntil(async () => {
      const rows = rowsSince(t0iso).filter((r) => (r.branch ?? "").startsWith("orchestrate-") && r.status === "running");
      return rows[0] ?? null;
    }, 120_000, 5_000);
    if (!orchA) {
      record("S2-3", "存在しない .tmp（スキル層 fail-closed）", "FAIL", "オーケストレーターセッションが起動しない");
    } else {
      createdSessionKeys.push(orchA.id);
      createdBranches.push({ repoDir: join(homedir(), "corp"), branch: orchA.branch });
      if (orchA.thread_id) createdThreads.push(orchA.thread_id);
      // スキルの fail-closed 報告（スレッド内エラーメッセージ）を待つ
      const errMsg = await pollUntil(async () => {
        const msgs = await fetchAllMessages(orchA.thread_id);
        return msgs.find((m) =>
          /存在しません|見つかりません|ありません|❌|エラー|invalid|not found/i.test(m.content ?? "") &&
          !(m.content ?? "").startsWith("🎼"),
        ) ?? null;
      }, 8 * 60_000, 15_000);
      const issuesAfter = countE2eIssues();
      const workers = rowsSince(t0iso).filter((r) => r.channel_name === "claude-hub-work" || (r.branch ?? "").startsWith("corp-dispatch-"));
      if (errMsg && issuesAfter === issuesBefore && workers.length === 0) {
        record("S2-3", "存在しない .tmp（スキル層 fail-closed）", "PASS",
          "スレッドにエラー報告 + ワーカー/Issue 増加なし");
      } else {
        record("S2-3", "存在しない .tmp（スキル層 fail-closed）", "FAIL",
          `errMsg=${!!errMsg} issues ${issuesBefore}→${issuesAfter} workers=${workers.length}`);
      }
    }
  }

  // ---------- S2-2: 多重 /orchestrate → 2 本目は起動せず案内 ----------
  if (orchA) {
    const before = runningByBranchPrefix("orchestrate-").length;
    const msgId = await postMessage(corpId, "/orchestrate 多重起動テスト（起動しないこと）");
    const notice = await pollUntil(async () => {
      const msgs = await fetchMessagesAfter(corpId, msgId);
      return msgs.find((m) => (m.content ?? "").includes("既にオーケストレーターが稼働中")) ?? null;
    }, 60_000, 5_000);
    const after = runningByBranchPrefix("orchestrate-").length;
    if (notice && after === before) {
      record("S2-2", "多重 /orchestrate → 案内のみ", "PASS", "ℹ️ 稼働中案内 + セッション増加なし");
    } else {
      record("S2-2", "多重 /orchestrate → 案内のみ", "FAIL", `notice=${!!notice} sessions ${before}→${after}`);
    }
    // S1 のために orchestrator A を停止（stop 経路の live smoke を兼ねる）
    await stopSessionQuiet(orchA.id);
    const stopped = await pollUntil(async () => {
      const r = dbRows(`SELECT status FROM sessions WHERE id = ?`, orchA.id)[0];
      return r && r.status !== "running" ? r : null;
    }, 60_000, 5_000);
    record("S3-stop", "session-ctl stop → sessions.db 反映", stopped ? "PASS" : "FAIL",
      stopped ? `status=${stopped.status}` : "stop 後も running のまま");
  } else {
    record("S2-2", "多重 /orchestrate → 案内のみ", "SKIP",
      orchestrateDriveAuthorized ? "S2-3 でオーケストレーター未起動のため" : AUTH_SKIP);
  }

  // ---------- S1: 正常系（.tmp 1 + テスト Issue 1） ----------
  if (!orchestrateDriveAuthorized) {
    for (const [id, name] of [
      ["S1-a", "起動（セッション + スレッド + welcome 引数エコー）"],
      ["S1-b", ".tmp → Issue 化（P2 AC-1）"],
      ["S1-c", "Mermaid 進捗ダッシュボード投稿（P2 AC-5）"],
      ["S1-d", "ワーカー起動（hub work 経路）"],
      ["S1-e", "完了 → 最終レポート"],
    ] as const) record(id, name, "SKIP", AUTH_SKIP);
  } else {
    // テスト Issue（ワーカー投入先。実装なし・コメントのみ指示）
    const issueBody = [
      "これは Epic #316 Phase 4 (#321) の E2E テスト専用 Issue です。",
      "",
      "## 指示（ワーカー向け）",
      "- 何も実装しないでください（コード変更・PR 作成は不要）",
      "- この Issue に `e2e-ack` とだけコメントしてください",
      "- コメント後、done ラベルを付けて終了してください",
      "",
      "## 統合ジャーニーAC（不要・理由: E2E テスト用の使い捨て Issue）",
    ].join("\n");
    writeFileSync("/tmp/e2e-issue-body.md", issueBody);
    const created = gh(["issue", "create", "--title", "[e2e-test] Phase4 E2E ワーカー疎通（実装なし・コメントのみ）", "--body-file", "/tmp/e2e-issue-body.md"]);
    const testIssue = Number(created.stdout.match(/\/issues\/(\d+)/)?.[1] ?? 0);
    if (!created.ok || !testIssue) {
      record("S1", "テスト Issue 作成", "FAIL", created.stderr.slice(0, 200));
      return finish();
    }
    createdIssues.push(testIssue);

    // テスト .tmp（Issue 化されるべき handoff）
    const tmpName = `${new Date().toISOString().slice(0, 10)}-e2e-orch-session.tmp`;
    const tmpPath = join(homedir(), ".claude", "sessions", tmpName);
    writeFileSync(tmpPath, [
      "# Session: [e2e-test] orchestrate E2E handoff",
      "",
      "## このハンドオフについて",
      "Epic claude-hub#316 Phase 4 (#321) の E2E テスト用ハンドオフです。",
      "",
      "## 未完了タスク",
      `- [ ] リポジトリ ${REPO} に、タイトル先頭が [e2e-test] の Issue としてこのタスクを永続化する`,
      "- [ ] Issue 本文に「何も実装せず e2e-ack とコメントして done ラベルを付けて終了」というワーカー向け指示を含める",
      "",
      "## 注意",
      "- 実 API 課金・Pushover・SNS 投稿を発火させないこと",
      "- 実装・PR 作成は不要（Issue 化のみが成果物）",
    ].join("\n"));
    createdTmpFiles.push(tmpPath);

    const issuesBefore = countE2eIssues();
    const t1iso = new Date().toISOString();
    await postMessage(corpId, `/orchestrate ${tmpPath} claude-hub#${testIssue}`);

    // (a) 起動契約: セッション行 + スレッド + 🎼 welcome（引数エコー）
    const orchB = await pollUntil(async () => {
      const rows = rowsSince(t1iso).filter((r) => (r.branch ?? "").startsWith("orchestrate-") && r.status === "running");
      return rows[0] ?? null;
    }, 120_000, 5_000);
    if (!orchB) {
      record("S1-a", "起動（セッション + スレッド + welcome）", "FAIL", "orchestrate-* running 行が現れない");
      return finish();
    }
    createdSessionKeys.push(orchB.id);
    createdBranches.push({ repoDir: join(homedir(), "corp"), branch: orchB.branch });
    if (orchB.thread_id) createdThreads.push(orchB.thread_id);
    const welcome = await pollUntil(async () => {
      const msgs = await fetchAllMessages(orchB.thread_id);
      return msgs.find((m) => (m.content ?? "").includes("🎼") && (m.content ?? "").includes("/orchestrate-runner")) ?? null;
    }, 60_000, 5_000);
    const echoOk = welcome && welcome.content.includes(tmpPath) && welcome.content.includes(`claude-hub#${testIssue}`);
    record("S1-a", "起動（セッション + スレッド + welcome 引数エコー）", welcome && echoOk ? "PASS" : "FAIL",
      welcome ? (echoOk ? `thread=${orchB.thread_id} branch=${orchB.branch}` : "welcome はあるが引数エコー不一致") : "🎼 welcome が現れない");

    // (b) 頭脳: .tmp → Issue 化（P2 AC-1）
    const newIssue = await pollUntil(async () => {
      const n = countE2eIssues();
      return n > issuesBefore ? n : null;
    }, BRAIN_TIMEOUT_MS, 30_000);
    if (newIssue !== null) {
      // 新規作成された [e2e-test] Issue を cleanup 対象に登録
      const list = gh(["issue", "list", "--state", "open", "--search", "[e2e-test] in:title", "--json", "number", "--jq", ".[].number"]);
      for (const n of list.stdout.split("\n").map(Number).filter(Boolean)) {
        if (!createdIssues.includes(n)) createdIssues.push(n);
      }
    }
    record("S1-b", ".tmp → Issue 化（P2 AC-1）", newIssue !== null ? "PASS" : "FAIL",
      newIssue !== null ? `[e2e-test] Issue が ${issuesBefore}→${newIssue} 件` : `${BRAIN_TIMEOUT_MS / 60000} 分以内に新規 Issue なし`);

    // (c) 頭脳: タスク解釈 + Mermaid ダッシュボード（P2 AC-5）
    const mermaid = await pollUntil(async () => {
      const msgs = await fetchAllMessages(orchB.thread_id);
      return msgs.find((m) => (m.content ?? "").includes("```mermaid")) ?? null;
    }, BRAIN_TIMEOUT_MS, 30_000);
    record("S1-c", "Mermaid 進捗ダッシュボード投稿（P2 AC-5）", mermaid ? "PASS" : "FAIL",
      mermaid ? "スレッドに ```mermaid ブロックあり" : "Mermaid ブロックが現れない");

    // (d) ワーカー起動観測（claude-hub タスク → hub work 経路）
    const worker = await pollUntil(async () => {
      const rows = rowsSince(t1iso).filter((r) => r.channel_name === "claude-hub-work");
      return rows[0] ?? null;
    }, BRAIN_TIMEOUT_MS, 30_000);
    if (worker) {
      createdSessionKeys.push(worker.id);
      if (worker.branch) createdBranches.push({ repoDir: join(homedir(), "claude-hub"), branch: worker.branch });
      if (worker.thread_id) createdThreads.push(worker.thread_id);
    }
    record("S1-d", "ワーカー起動（hub work 経路）", worker ? "PASS" : "FAIL",
      worker ? `branch=${worker.branch} thread=${worker.thread_id}` : "claude-hub-work セッションが現れない");

    // (e) --full: 完了 → 最終レポート（Phase 5 受け入れ実走で使用）
    if (FULL) {
      const report = await pollUntil(async () => {
        const msgs = await fetchAllMessages(orchB.thread_id);
        return msgs.find((m) => /最終レポート|final report/i.test(m.content ?? "")) ?? null;
      }, 60 * 60_000, 60_000);
      record("S1-e", "完了 → 最終レポート", report ? "PASS" : "FAIL",
        report ? "最終レポート投稿あり" : "60 分以内に最終レポートなし");
    } else {
      record("S1-e", "完了 → 最終レポート", "SKIP", "--full 未指定（Phase 5 受け入れ実走で検証）");
    }

    // オーケストレーター B を停止（cleanup の一部を先行）
    await stopSessionQuiet(orchB.id);
  }

  // ---------- S1b: hub work 経路の決定的検証（P3 実機残検証） ----------
  {
    const issueBody = "E2E テスト専用（Phase 4 #321 / S1b）。何もしないでください。\n\n## 統合ジャーニーAC（不要・理由: E2E テスト用の使い捨て Issue）";
    writeFileSync("/tmp/e2e-issue-body2.md", issueBody);
    const created = gh(["issue", "create", "--title", "[e2e-test] Phase4 S1b hub-work 直接起動 smoke", "--body-file", "/tmp/e2e-issue-body2.md"]);
    const n = Number(created.stdout.match(/\/issues\/(\d+)/)?.[1] ?? 0);
    if (!n) {
      record("S1b", "hub work 直接起動", "FAIL", `テスト Issue 作成失敗: ${created.stderr.slice(0, 120)}`);
    } else {
      createdIssues.push(n);
      const branch = `hub-work-${n}`;
      const tIso = new Date().toISOString();
      const fx = createRealEffects();
      const code = await runSessionCtl(["start-hub-worker", branch, String(n), "no-template"], fx);
      const row = code === 0 ? await pollUntil(async () => {
        const rows = rowsSince(tIso).filter((r) => r.channel_name === "claude-hub-work" && r.branch === branch && r.status === "running");
        return rows[0] ?? null;
      }, 180_000, 5_000) : null;
      if (!row) {
        record("S1b", "hub work 直接起動（start-hub-worker）", "FAIL", `exit=${code}, running 行なし`);
      } else {
        createdSessionKeys.push(row.id);
        createdBranches.push({ repoDir: join(homedir(), "claude-hub"), branch });
        if (row.thread_id) createdThreads.push(row.thread_id);
        record("S1b-start", "hub work 直接起動（start-hub-worker）", "PASS",
          `branch=${branch} thread=${row.thread_id} channel_name=${row.channel_name}`);
        // send → stop
        const sendCode = await runSessionCtl(["send", row.id, "e2e ping: 応答不要です。何もしないでください。"], createRealEffects());
        record("S1b-send", "hub work セッションへ send", sendCode === 0 ? "PASS" : "FAIL", `exit=${sendCode}`);
        await stopSessionQuiet(row.id);
        const stopped = await pollUntil(async () => {
          const r = dbRows(`SELECT status,stopped_reason FROM sessions WHERE id = ?`, row.id)[0];
          return r && r.status !== "running" ? r : null;
        }, 60_000, 5_000);
        record("S1b-stop", "hub work セッション stop → DB 反映", stopped ? "PASS" : "FAIL",
          stopped ? `status=${stopped.status} reason=${stopped.stopped_reason}` : "running のまま");
        // hijoguchi 非干渉: スレッドに hijoguchi Bot の投稿がない
        const msgs = row.thread_id ? await fetchAllMessages(row.thread_id) : [];
        const intruded = msgs.some((m) => m.author?.id === HIJOGUCHI_BOT_ID);
        record("S1b-hijo", "hijoguchi が work スレッドに割り込まない", intruded ? "FAIL" : "PASS",
          intruded ? "hijoguchi の投稿を検出" : `スレッド ${msgs.length} 件に hijoguchi 投稿なし`);
      }
    }
  }

  // ---------- S2-4 / S2-5（長時間・モデル依存 → Phase 5 送り） ----------
  record("S2-4", "ワーカー故意失敗 3 回 → error loop 停止（P2 AC-3）", "SKIP",
    "error loop 検知はオーケストレーター（モデル）挙動で、決定的アサート不能 + 30 分超。Phase 5 受け入れ実走で検証");
  record("S2-5", "オーケストレーター kill → resume 再入で重複なし（P2 AC-4 smoke）", "SKIP",
    "resume は Epic 番号前提（SKILL Phase E）でテスト Epic が必要。Phase 5 で検証（corp 台帳の冪等性は agent-base 側テストで担保済み）");

  // ---------- S3: 既存機能の回帰（live 分） ----------
  {
    // hijoguchi プロセス非干渉（pid 不変）
    const hijoguchiPidAfter = Bun.spawnSync(["pgrep", "-f", "CLAUDE_HUB_HIJOGUCHI_SESSION=1"]).stdout.toString().trim();
    record("S3-hijo", "hijoguchi プロセス非干渉（pid 不変）",
      hijoguchiPidBefore && hijoguchiPidBefore === hijoguchiPidAfter ? "PASS" : "FAIL",
      `before=[${hijoguchiPidBefore}] after=[${hijoguchiPidAfter}]`);

    // session-ctl list（read-only 面）が生きている
    const listCode = await runSessionCtl(["list"], createRealEffects());
    record("S3-list", "session-ctl list（sessions.db read-only）", listCode === 0 ? "PASS" : "FAIL", `exit=${listCode}`);

    // /session・/dispatch の slash / メッセージ経路は Bot からは駆動不能（Discord 制約:
    // Bot は他 Bot の application command を実行できない）。hermetic 回帰（wrapper の
    // bun test）+ 手動確認（.claude/commands/local-e2e-discord.md）でカバーする。
    record("S3-slash", "/session start|list|stop|resume（実 Discord slash）", "SKIP",
      "Bot は他 Bot の slash command を起動できない（Discord 制約）。hermetic 回帰 + local-e2e-discord（Chrome 手動）でカバー。Phase 5 実走時に目視");
    record("S3-hijo-mention", "hijoguchi メンション応答", "SKIP",
      "メンション応答は allowFrom=[owner] のため owner アカウントからのみ検証可能。Phase 5 実走時に目視");
  }

  // ---------- cleanup ----------
  if (KEEP) {
    console.log("cleanup: --keep 指定のためスキップ");
  } else {
    await cleanup();
  }
  return finish();
}

function countE2eIssues(): number {
  const r = gh(["issue", "list", "--state", "all", "--search", "[e2e-test] in:title", "--json", "number", "--jq", "length"]);
  return Number(r.stdout || "0");
}

async function cleanup(): Promise<void> {
  console.log("== cleanup ==");
  // 1. 残っている running セッションを停止
  for (const key of createdSessionKeys) {
    const r = dbRows(`SELECT status FROM sessions WHERE id = ?`, key)[0];
    if (r?.status === "running") await stopSessionQuiet(key);
  }
  // 2. テストで作られた open PR（head が記録 branch のもの）を close（意図的 fail の draft 含む）
  for (const { branch } of createdBranches) {
    const pr = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--jq", ".[].number"]);
    for (const n of pr.stdout.split("\n").map(Number).filter(Boolean)) {
      gh(["pr", "close", String(n), "-c", "E2E テスト残骸のため close（#321 cleanup）"]);
      console.log(`cleanup: PR #${n} closed`);
    }
  }
  // 3. テスト Issue を close
  for (const n of createdIssues) {
    gh(["issue", "close", String(n), "-c", "E2E テスト完了のため close（#321 cleanup）"]);
    console.log(`cleanup: Issue #${n} closed`);
  }
  // 4. worktree + ローカル branch + （あれば）remote branch を削除
  for (const { repoDir, branch } of createdBranches) {
    const wt = join(repoDir, ".claude", "worktrees", branch);
    if (existsSync(wt)) {
      Bun.spawnSync(["git", "-C", repoDir, "worktree", "remove", "--force", wt]);
      console.log(`cleanup: worktree ${wt} removed`);
    }
    Bun.spawnSync(["git", "-C", repoDir, "branch", "-D", branch]);
    Bun.spawnSync(["git", "-C", repoDir, "push", "origin", "--delete", branch]);
  }
  // 5. スレッドを archive（driver Bot 権限で best-effort）
  for (const tid of createdThreads) {
    const r = await rest("PATCH", `/channels/${tid}`, { archived: true });
    console.log(`cleanup: thread ${tid} archive HTTP ${r.status}`);
  }
  // 6. テスト .tmp 削除
  for (const p of createdTmpFiles) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
}

function finish(): number {
  console.log("\n## E2E 実測結果");
  console.log("| ID | 検証内容 | 判定 | 実測 |");
  console.log("|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.id} | ${r.name} | ${r.verdict} | ${r.evidence.replaceAll("|", "\\|")} |`);
  }
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const skip = results.filter((r) => r.verdict === "SKIP").length;
  console.log(`\n合計: ${pass} PASS / ${fail} FAIL / ${skip} SKIP`);
  return fail === 0 ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    });
}
