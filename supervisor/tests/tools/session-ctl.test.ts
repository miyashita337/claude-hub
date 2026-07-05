import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { SessionRow } from "../../src/infra/db";
import {
  runSessionCtl,
  tmuxNameForThread,
  createRealEffects,
  type SessionCtlEffects,
  type SessionStore,
} from "../../tools/session-ctl";
import { SessionManager } from "../../src/session/manager";

/**
 * session-ctl ローカル CLI（Epic #316 Phase 3 / #320）の fake adapters テスト。
 *
 * - sessions.db は読み取り専用（SessionStore に書き込み API が存在しないことが
 *   構造的担保。実配線は bun:sqlite `{readonly:true}`）
 * - send は relay.ts の sendToPane を共有（ここでは fake が受け取る tmux 名 /
 *   テキストの正しさを検証。送信シーケンス自体は relay.test.ts が担保）
 * - stop は DB に書かず、Supervisor watcher の status 反映を読み取りで確認する
 */

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    channel_name: "claude-hub-work",
    thread_id: "111122223333444455",
    project_dir: "/Users/x/claude-hub/.claude/worktrees/feat-320",
    pid: 4242,
    claude_session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    started_at: "2026-07-05T00:00:00.000Z",
    last_activity_at: "2026-07-05T00:10:00.000Z",
    status: "running",
    stopped_reason: null,
    branch: "feat-320",
    ...overrides,
  };
}

interface FakeCalls {
  sends: Array<{ tmuxName: string; text: string }>;
  killedPids: Array<{ pid: number; signal: string }>;
  killedTmux: string[];
  posts: Array<{ url: string; body: unknown }>;
  out: string[];
  err: string[];
}

function fakeFx(opts: {
  rows?: SessionRow[];
  tmuxAlive?: boolean;
  pidAlive?: boolean;
  relayPort?: number | null;
  httpResponse?: { status: number; body: unknown };
  /** stop 中、tmux kill 後に store が返す status（Supervisor watcher 反映の模擬）。 */
  statusAfterKill?: string;
} = {}): { fx: SessionCtlEffects; calls: FakeCalls } {
  const calls: FakeCalls = {
    sends: [],
    killedPids: [],
    killedTmux: [],
    posts: [],
    out: [],
    err: [],
  };
  const rows = opts.rows ?? [];
  let killed = false;

  const currentRows = (): SessionRow[] =>
    killed && opts.statusAfterKill
      ? rows.map((r) => ({
          ...r,
          status: opts.statusAfterKill!,
          stopped_reason: "tmux_exited",
        }))
      : rows;

  const byKey = (key: string, runningOnly: boolean): SessionRow | undefined =>
    currentRows().find(
      (r) =>
        (r.id === key || r.thread_id === key || r.claude_session_id === key) &&
        (!runningOnly || r.status === "running"),
    );

  const store: SessionStore = {
    listRunning: () => currentRows().filter((r) => r.status === "running"),
    findByKey: (key) => byKey(key, false),
    findRunningByKey: (key) => byKey(key, true),
  };

  const fx: SessionCtlEffects = {
    store,
    sendText: async (tmuxName, text) => {
      calls.sends.push({ tmuxName, text });
    },
    hasTmuxSession: async () => opts.tmuxAlive ?? true,
    killTmuxSession: async (name) => {
      calls.killedTmux.push(name);
      killed = true;
    },
    killPid: (pid, signal) => {
      calls.killedPids.push({ pid, signal });
      return true;
    },
    pidAlive: () => opts.pidAlive ?? true,
    sleep: async () => {},
    readRelayPort: () => (opts.relayPort === undefined ? 45678 : opts.relayPort),
    httpPost: async (url, body) => {
      calls.posts.push({ url, body });
      return opts.httpResponse ?? { status: 200, body: { ok: true, threadId: "T1", queued: false, injected: "/impl 1" } };
    },
    out: (line) => calls.out.push(line),
    err: (line) => calls.err.push(line),
  };
  return { fx, calls };
}

const STOP_OPTS = { graceMs: 0, statusWaitMs: 10, statusPollMs: 1 };

describe("tmux セッション名マッピング", () => {
  test("Supervisor の公式マッピング（claude-<threadId12>）と一致する", () => {
    const threadId = "111122223333444455";
    expect(tmuxNameForThread(threadId)).toBe(
      SessionManager.tmuxSessionNameFor(threadId),
    );
    expect(tmuxNameForThread(threadId)).toBe("claude-111122223333");
  });
});

describe("list", () => {
  test("running なし → 案内を出して 0", async () => {
    const { fx, calls } = fakeFx();
    expect(await runSessionCtl(["list"], fx)).toBe(0);
    expect(calls.out[0]).toContain("running セッションなし");
  });

  test("running 行を列挙して件数を出す（AC-1: sessions.db と一致）", async () => {
    const rows = [row(), row({ id: "sess-2", thread_id: "999900001111222233", branch: "b2" })];
    const { fx, calls } = fakeFx({ rows });
    expect(await runSessionCtl(["list"], fx)).toBe(0);
    expect(calls.out.filter((l) => l.startsWith("id=")).length).toBe(2);
    expect(calls.out.join("\n")).toContain("sess-1");
    expect(calls.out.join("\n")).toContain("sess-2");
    expect(calls.out.at(-1)).toContain("計 2 件");
  });

  test("stopped 行は数えない", async () => {
    const rows = [row({ status: "stopped", stopped_reason: "manual" })];
    const { fx, calls } = fakeFx({ rows });
    expect(await runSessionCtl(["list"], fx)).toBe(0);
    expect(calls.out[0]).toContain("running セッションなし");
  });
});

describe("status", () => {
  test("未知 id → exit 1", async () => {
    const { fx, calls } = fakeFx();
    expect(await runSessionCtl(["status", "nope"], fx)).toBe(1);
    expect(calls.err[0]).toContain("見つかりません");
  });

  test("running + pid/tmux alive → liveness=alive", async () => {
    const { fx, calls } = fakeFx({ rows: [row()], tmuxAlive: true, pidAlive: true });
    expect(await runSessionCtl(["status", "sess-1"], fx)).toBe(0);
    expect(calls.out.join("\n")).toContain("liveness=alive");
  });

  test("tmux 消滅 → liveness=dead（DB より現実を優先）", async () => {
    const { fx, calls } = fakeFx({ rows: [row()], tmuxAlive: false });
    expect(await runSessionCtl(["status", "sess-1"], fx)).toBe(0);
    expect(calls.out.join("\n")).toContain("liveness=dead");
  });

  test("claude_session_id でも引ける", async () => {
    const { fx } = fakeFx({ rows: [row()] });
    expect(
      await runSessionCtl(["status", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], fx),
    ).toBe(0);
  });
});

describe("send", () => {
  test("thread_id 指定で正しい tmux 名へ送信（AC-2）", async () => {
    const { fx, calls } = fakeFx({ rows: [row()] });
    expect(
      await runSessionCtl(["send", "111122223333444455", "echo", "hello"], fx),
    ).toBe(0);
    expect(calls.sends).toEqual([
      { tmuxName: "claude-111122223333", text: "echo hello" },
    ]);
  });

  test("session id 指定でも同じセッションへ解決される", async () => {
    const { fx, calls } = fakeFx({ rows: [row()] });
    expect(await runSessionCtl(["send", "sess-1", "hi"], fx)).toBe(0);
    expect(calls.sends[0]!.tmuxName).toBe("claude-111122223333");
  });

  test("running でないセッションには送らない", async () => {
    const { fx, calls } = fakeFx({ rows: [row({ status: "stopped" })] });
    expect(await runSessionCtl(["send", "sess-1", "hi"], fx)).toBe(1);
    expect(calls.sends).toHaveLength(0);
  });

  test("tmux ペイン消滅 → 送信せずエラー", async () => {
    const { fx, calls } = fakeFx({ rows: [row()], tmuxAlive: false });
    expect(await runSessionCtl(["send", "sess-1", "hi"], fx)).toBe(1);
    expect(calls.sends).toHaveLength(0);
    expect(calls.err[0]).toContain("tmux");
  });

  test("引数不足 → usage エラー", async () => {
    const { fx } = fakeFx({ rows: [row()] });
    expect(await runSessionCtl(["send", "sess-1"], fx)).toBe(1);
  });
});

describe("stop", () => {
  test("SIGTERM → tmux kill の順で、DB へは書かず watcher 反映を読み取り確認（AC-3）", async () => {
    const { fx, calls } = fakeFx({ rows: [row()], statusAfterKill: "stopped" });
    expect(await runSessionCtl(["stop", "sess-1"], fx, STOP_OPTS)).toBe(0);
    expect(calls.killedPids).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(calls.killedTmux).toEqual(["claude-111122223333"]);
    const outText = calls.out.join("\n");
    // worktree 非破壊（RW-046）: tmux_exited 経路は worktree を残す。
    expect(outText).toContain("worktree は保持");
    expect(outText).toContain("status=stopped");
    expect(outText).toContain("tmux_exited");
  });

  test("Supervisor 停止中（status が反映されない）でも kill は完了し警告を出す", async () => {
    const { fx, calls } = fakeFx({ rows: [row()] }); // statusAfterKill なし
    expect(await runSessionCtl(["stop", "sess-1"], fx, STOP_OPTS)).toBe(0);
    expect(calls.killedTmux).toEqual(["claude-111122223333"]);
    expect(calls.out.join("\n")).toContain("Supervisor が停止中の可能性");
  });

  test("running でないセッション → exit 1（何も kill しない）", async () => {
    const { fx, calls } = fakeFx({ rows: [row({ status: "stopped" })] });
    expect(await runSessionCtl(["stop", "sess-1"], fx, STOP_OPTS)).toBe(1);
    expect(calls.killedPids).toHaveLength(0);
    expect(calls.killedTmux).toHaveLength(0);
  });
});

describe("start-hub-worker", () => {
  test("POST /hub-work に {branch, issueNumber, selector} を送る", async () => {
    const { fx, calls } = fakeFx({ relayPort: 50123 });
    expect(
      await runSessionCtl(["start-hub-worker", "feat-320", "320", "pdca"], fx),
    ).toBe(0);
    expect(calls.posts).toEqual([
      {
        url: "http://127.0.0.1:50123/hub-work",
        body: { branch: "feat-320", issueNumber: 320, selector: "pdca" },
      },
    ]);
    expect(calls.out[0]).toContain("受け付けました");
  });

  test("selector 省略時は payload に含めない", async () => {
    const { fx, calls } = fakeFx();
    expect(await runSessionCtl(["start-hub-worker", "feat-320", "320"], fx)).toBe(0);
    expect(calls.posts[0]!.body).toEqual({ branch: "feat-320", issueNumber: 320 });
  });

  test("ポートファイルなし（Supervisor 未起動）→ exit 1、HTTP は呼ばない", async () => {
    const { fx, calls } = fakeFx({ relayPort: null });
    expect(await runSessionCtl(["start-hub-worker", "b", "1"], fx)).toBe(1);
    expect(calls.posts).toHaveLength(0);
    expect(calls.err[0]).toContain("Supervisor");
  });

  test("issueNumber が整数でない → exit 1、HTTP は呼ばない", async () => {
    const { fx, calls } = fakeFx();
    expect(await runSessionCtl(["start-hub-worker", "b", "abc"], fx)).toBe(1);
    expect(calls.posts).toHaveLength(0);
  });

  test("Supervisor がエラーを返す → exit 1 でエラー本文を表示", async () => {
    const { fx, calls } = fakeFx({
      httpResponse: { status: 400, body: { error: "branch 名が不正です" } },
    });
    expect(await runSessionCtl(["start-hub-worker", "b", "1"], fx)).toBe(1);
    expect(calls.err[0]).toContain("branch 名が不正です");
  });
});

describe("usage", () => {
  test("help → 0", async () => {
    const { fx, calls } = fakeFx();
    expect(await runSessionCtl(["help"], fx)).toBe(0);
    expect(calls.out[0]).toContain("session-ctl");
  });

  test("未知サブコマンド → 1", async () => {
    const { fx } = fakeFx();
    expect(await runSessionCtl(["frobnicate"], fx)).toBe(1);
  });

  test("引数なし → 1", async () => {
    const { fx } = fakeFx();
    expect(await runSessionCtl([], fx)).toBe(1);
  });
});

describe("実 DB 読み取り（createRealEffects の store、読み取り専用）", () => {
  test("実 sqlite ファイルから running 行を読める + readonly で開いている", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-ctl-test-"));
    const dbPath = join(dir, "sessions.db");
    const prevEnv = process.env.SUPERVISOR_DB_PATH;
    try {
      // Supervisor と同じスキーマ + WAL で行を用意する（書くのはテスト側のみ）。
      const writer = new Database(dbPath);
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          channel_name TEXT NOT NULL,
          thread_id TEXT,
          project_dir TEXT NOT NULL,
          pid INTEGER,
          claude_session_id TEXT,
          started_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          stopped_reason TEXT,
          branch TEXT
        )
      `);
      writer
        .prepare(
          `INSERT INTO sessions (id, channel_name, thread_id, project_dir, pid, claude_session_id, started_at, last_activity_at, status, branch)
           VALUES ('s1', 'claude-hub-work', 't1', '/x', 1, NULL, '2026-07-05T00:00:00Z', '2026-07-05T00:00:00Z', 'running', 'feat-320')`,
        )
        .run();
      writer.close();

      process.env.SUPERVISOR_DB_PATH = dbPath;
      const fx = createRealEffects();
      const rows = fx.store.listRunning();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("s1");
      expect(fx.store.findByKey("t1")?.id).toBe("s1");
      expect(fx.store.findRunningByKey("s1")?.branch).toBe("feat-320");
      // SessionStore には書き込み API が存在しない（読み取り専用の構造的担保）。
      expect("insert" in fx.store).toBe(false);
      expect("update" in fx.store).toBe(false);
    } finally {
      if (prevEnv === undefined) delete process.env.SUPERVISOR_DB_PATH;
      else process.env.SUPERVISOR_DB_PATH = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
