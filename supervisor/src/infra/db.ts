import { Database } from "bun:sqlite";
import { resolve } from "path";
import { homedir, tmpdir } from "os";

/**
 * テスト実行中か（Issue #308）。`bun test` は NODE_ENV を "test" に設定する
 * （Bun 1.3.11 で実測: `env -u NODE_ENV bun test` でも "test"）。
 * SUPERVISOR_TEST_ISOLATION は tests/setup/db-isolation.ts preload が立てる
 * マーカーで、NODE_ENV を上書きされてもガードが外れないようにする二重化。
 */
function isUnderTest(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "test" || env.SUPERVISOR_TEST_ISOLATION === "1";
}

/**
 * テスト実行中に開いてよい sqlite パスか。`:memory:`（および URI 形式）と
 * 一時ディレクトリ配下のみを許可する allowlist ＝「permissive より restrictive」
 * （rules/general/defensive-programming.md）。本番 sessions.db はもちろん、
 * 将来うっかり指定された任意の実ファイルも弾く。
 */
function isTestSafeDbPath(path: string): boolean {
  // Bun/sqlite で filesystem に触れない形式。"" は bun:sqlite の匿名 in-memory。
  if (path === "" || path.includes(":memory:")) return true;
  // macOS の tmpdir() は /var/folders/...、/tmp は /private/tmp への symlink。
  // mkdtemp(join(tmpdir(), …)) 由来のパス（tests/tools/session-ctl.test.ts）を
  // 通しつつ、いずれの表記でも一時領域だけを許可する。
  return [tmpdir(), "/tmp", "/private/tmp"]
    .map((root) => root.replace(/\/+$/, "") + "/")
    .some((root) => path.startsWith(root));
}

/**
 * Fail-fast ガード（Issue #308）: テスト実行中に本番 sessions.db を開こうと
 * したら即座に throw する。
 *
 * 背景: preload（tests/setup/db-isolation.ts）が一次防御だが、preload が外され
 * た・新しい入口が env を無視した、といった経路が残る。実測では隔離が壊れると
 * テストは 72 pass / 0 fail のまま本番の行を消す（silent data loss）ため、
 * 「黙って壊す」より「その場で落ちる」方を選ぶ。
 */
export function assertTestDbIsolation(
  path: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isUnderTest(env)) return;
  if (isTestSafeDbPath(path)) return;
  throw new Error(
    `[db] テスト実行中に隔離されていない sessions.db を開こうとしました: ${path}\n` +
      `これは本番のセッション行を破壊しうるため中断しました（Issue #308）。\n` +
      `対処: SUPERVISOR_DB_PATH=":memory:" を設定するか、一時ディレクトリ配下の ` +
      `パスを指定してください。通常は supervisor/bunfig.toml の ` +
      `[test].preload（tests/setup/db-isolation.ts）が自動で設定します。`,
  );
}

/**
 * sessions.db の実パスを解決する（#320 で外出し）。Supervisor 本体（下の
 * DB_PATH、モジュールロード時に固定）と読み取り専用 CLI（tools/session-ctl.ts、
 * 呼び出し時に解決）が同じ規則を共有するための single source of truth。
 *
 * 解決と同時に #308 のガードを通すので、パスを得る経路すべて（singleton /
 * session-ctl / e2e-live）が自動的に保護される。
 */
export function resolveDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const path =
    env.SUPERVISOR_DB_PATH ??
    resolve(homedir(), "claude-hub", "supervisor", "sessions.db");
  assertTestDbIsolation(path, env);
  return path;
}

const DB_PATH = resolveDbPath();

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel_name TEXT NOT NULL,
        thread_id TEXT,
        project_dir TEXT NOT NULL,
        pid INTEGER,
        claude_session_id TEXT,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        stopped_reason TEXT
      )
    `);
    // Migration: add thread_id if missing (for existing DBs)
    addColumnIfMissing(db, "thread_id", "TEXT");
    // Migration: add branch if missing (Issue #175). Nullable so existing rows
    // (started before this column) stay valid; resume of such a row falls back
    // to the display-name-only thread title.
    addColumnIfMissing(db, "branch", "TEXT");
    // Issue #305 (層3): one-time nonce ledger for Pushover one-tap action tokens.
    // A tapped `/act?t=<token>` URL is replay-protected by recording its nonce
    // here; a second tap of the same URL finds the row and is rejected. PRIMARY
    // KEY on nonce makes the consume atomic (INSERT ... ON CONFLICT DO NOTHING).
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_nonces (
        nonce TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        used_at TEXT NOT NULL
      )
    `);
  }
  return db;
}

/**
 * Idempotent `ALTER TABLE sessions ADD COLUMN`. Swallows only the
 * already-exists case; any other failure (locked DB, disk error, bad type) is
 * rethrown so a real migration failure surfaces here instead of as a confusing
 * INSERT error later (CodeRabbit review).
 */
function addColumnIfMissing(db: Database, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("duplicate column")) throw err;
  }
}

export interface SessionRow {
  id: string;
  channel_name: string;
  thread_id: string | null;
  project_dir: string;
  pid: number | null;
  claude_session_id: string | null;
  started_at: string;
  last_activity_at: string;
  status: string;
  stopped_reason: string | null;
  /** Branch the session runs on, when started via `/session start <branch>` (Issue #175). */
  branch: string | null;
}

export function insertSession(
  // `branch` is optional so existing callers/tests that predate Issue #175 keep
  // compiling; it defaults to NULL (no branch recorded).
  row: Omit<SessionRow, "stopped_reason" | "branch"> & { branch?: string | null }
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (id, channel_name, thread_id, project_dir, pid, claude_session_id, started_at, last_activity_at, status, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.channel_name,
    row.thread_id,
    row.project_dir,
    row.pid,
    row.claude_session_id,
    row.started_at,
    row.last_activity_at,
    row.status,
    row.branch ?? null
  );
}

export function updateSessionStatus(
  id: string,
  status: string,
  reason?: string
): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET status = ?, stopped_reason = ? WHERE id = ?`
  ).run(status, reason ?? null, id);
}

export function updateSessionClaudeId(
  id: string,
  claudeSessionId: string
): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET claude_session_id = ? WHERE id = ?`
  ).run(claudeSessionId, id);
}

export function updateSessionActivity(id: string): void {
  const db = getDb();
  db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id
  );
}

export function updateSessionPid(id: string, pid: number): void {
  const db = getDb();
  db.prepare(`UPDATE sessions SET pid = ? WHERE id = ?`).run(pid, id);
}

export function getRunningSessionByChannel(
  channelName: string
): SessionRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM sessions WHERE channel_name = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`
    )
    .get(channelName) as SessionRow | undefined;
}

export function getRunningSessionByThread(
  threadId: string
): SessionRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM sessions WHERE thread_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`
    )
    .get(threadId) as SessionRow | undefined;
}

export function getSessionByClaudeSessionId(
  claudeSessionId: string
): SessionRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM sessions WHERE claude_session_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(claudeSessionId) as SessionRow | undefined;
}

export function getRunningSessions(): SessionRow[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM sessions WHERE status = 'running' ORDER BY started_at`)
    .all() as SessionRow[];
}

export function getLastSessionByChannel(
  channelName: string
): SessionRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM sessions WHERE channel_name = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(channelName) as SessionRow | undefined;
}

/**
 * Most-recent session row for the given thread regardless of status. Used by
 * the authoritative liveness check (Issue #168) and any caller that needs the
 * latest run on a thread — including stopped ones. Returns `undefined` when
 * the thread has never been seen.
 *
 * Renamed from `getLastSessionByThread` in Issue #168 to align with the rest
 * of the file's `getSessionBy<Key>` naming (mirrors
 * `getSessionByClaudeSessionId`). The old name had zero callers.
 */
export function getSessionByThreadId(
  threadId: string
): SessionRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM sessions WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(threadId) as SessionRow | undefined;
}

export function getRunningSessionsByChannel(
  channelName: string
): SessionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM sessions WHERE channel_name = ? AND status = 'running' ORDER BY started_at`
    )
    .all(channelName) as SessionRow[];
}

/**
 * Atomically consume a one-time action nonce (Issue #305, 層3). Returns `true`
 * when the nonce was newly recorded (first use → the caller may proceed), and
 * `false` when it was already present (replay → the caller must reject with a
 * "used" error). Atomicity comes from the PRIMARY KEY on `nonce`: the
 * `ON CONFLICT DO NOTHING` makes a duplicate insert a no-op, so `changes === 1`
 * uniquely identifies the first caller even under concurrent taps.
 */
export function consumeActionNonce(nonce: string, action: string): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO action_nonces (nonce, action, used_at) VALUES (?, ?, ?)
       ON CONFLICT(nonce) DO NOTHING`
    )
    .run(nonce, action, new Date().toISOString());
  return result.changes === 1;
}
