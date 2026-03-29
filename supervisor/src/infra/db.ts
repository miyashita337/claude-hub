import { Database } from "bun:sqlite";
import { resolve } from "path";
import { homedir } from "os";

const DB_PATH = resolve(homedir(), "claude-hub", "supervisor", "sessions.db");

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
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN thread_id TEXT`);
    } catch {
      // Column already exists
    }
  }
  return db;
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
}

export function insertSession(row: Omit<SessionRow, "stopped_reason">): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (id, channel_name, thread_id, project_dir, pid, claude_session_id, started_at, last_activity_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.channel_name,
    row.thread_id,
    row.project_dir,
    row.pid,
    row.claude_session_id,
    row.started_at,
    row.last_activity_at,
    row.status
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

export function getLastSessionByThread(
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
