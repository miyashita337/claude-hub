import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  ERROR_LOOP_THRESHOLD,
  assertIsolatedEnv,
  detectErrorLoop,
  errorSignature,
  formatErrorLoopReport,
  looksLikeError,
} from "../../tools/e2e-isolated";

/**
 * e2e-live S2-4（error loop 検知）の純関数テスト（Issue #386 / Epic #381）。
 *
 * ライブ側（実 tmux + mock claude + 実 session-ctl stop）は e2e-live.ts の
 * `--scenario s2-4` が回す。ここで固定するのは、そのライブ実行が依存する
 * 判定規則そのもの:
 *
 *   - 可変部（タイムスタンプ / 試行回数）が違っても同じ失敗を同一視できるか
 *   - 別の失敗まで同一視していないか（過剰正規化の検出）
 *   - 成功応答の反復を error loop と誤判定しないか（誤 kill 防止）
 *   - 隔離 env の fail-closed ガードが本番資産を守るか
 *
 * 本ファイルは tmux も DB も触らないため CI で常時実行できる（#144 の CI 編入で
 * ライブ側が入るまでの間、規則部分だけは機械的に守られる）。
 */

/** claude-error-loop-mock.sh が実際に吐く形（可変部だけが違う 3 応答）。 */
const MOCK_REPLIES = [
  "[2026-08-09T10:00:01Z] attempt 1: Error: EACCES: permission denied, open '/tmp/e2e-error-loop.lock'",
  "[2026-08-09T10:00:09Z] attempt 2: Error: EACCES: permission denied, open '/tmp/e2e-error-loop.lock'",
  "[2026-08-09T10:00:17Z] attempt 3: Error: EACCES: permission denied, open '/tmp/e2e-error-loop.lock'",
];

describe("errorSignature", () => {
  test("可変部（タイムスタンプ・試行回数）が違っても同一署名になる", () => {
    const signatures = new Set(MOCK_REPLIES.map(errorSignature));
    expect(signatures.size).toBe(1);
  });

  test("エラー中核が違えば別署名になる（過剰正規化の検出）", () => {
    const a = errorSignature(
      "[2026-08-09T10:00:01Z] attempt 1: Error: EACCES: permission denied",
    );
    const b = errorSignature(
      "[2026-08-09T10:00:01Z] attempt 1: Error: ENOENT: no such file or directory",
    );
    expect(a).not.toBe(b);
  });

  test("ANSI エスケープと 16 進 ID を落とす", () => {
    const withAnsi = "\u001B[31mError: task 9f8e7d6c5b4a3210 failed\u001B[0m";
    const plain = "Error: task 0123456789abcdef failed";
    expect(errorSignature(withAnsi)).toBe(errorSignature(plain));
  });

  test("空白の揺れを吸収する", () => {
    expect(errorSignature("Error:   foo \n  bar ")).toBe(
      errorSignature("Error: foo bar"),
    );
  });
});

describe("looksLikeError", () => {
  test("エラー表現を検出する（日英）", () => {
    expect(looksLikeError("Error: boom")).toBe(true);
    expect(looksLikeError("処理に失敗しました")).toBe(true);
    expect(looksLikeError("Traceback (most recent call last)")).toBe(true);
  });

  test("通常の応答はエラー扱いしない", () => {
    expect(looksLikeError("[mock-claude] received: ping")).toBe(false);
  });
});

describe("detectErrorLoop", () => {
  test("同一エラー 3 回で検知する（policy B-3）", () => {
    const verdict = detectErrorLoop(MOCK_REPLIES);
    expect(verdict.detected).toBe(true);
    expect(verdict.count).toBe(ERROR_LOOP_THRESHOLD);
    expect(verdict.considered).toBe(3);
    expect(verdict.signature).toContain("EACCES");
  });

  test("2 回では検知しない（閾値の下側境界）", () => {
    const verdict = detectErrorLoop(MOCK_REPLIES.slice(0, 2));
    expect(verdict.detected).toBe(false);
    expect(verdict.count).toBe(2);
  });

  test("別々のエラー 3 種では検知しない", () => {
    const verdict = detectErrorLoop([
      "Error: EACCES: permission denied",
      "Error: ENOENT: no such file",
      "Error: ETIMEDOUT: timed out",
    ]);
    expect(verdict.detected).toBe(false);
    expect(verdict.count).toBe(1);
  });

  test("同一の成功応答 3 回は error loop にしない（誤 kill 防止）", () => {
    const verdict = detectErrorLoop([
      "[mock-claude] received: ping",
      "[mock-claude] received: ping",
      "[mock-claude] received: ping",
    ]);
    expect(verdict.detected).toBe(false);
    expect(verdict.considered).toBe(0);
    expect(verdict.signature).toBeNull();
  });

  test("エラーに混在する成功応答は判定対象から外れる", () => {
    const verdict = detectErrorLoop([
      MOCK_REPLIES[0]!,
      "[mock-claude] received: ok",
      MOCK_REPLIES[1]!,
      MOCK_REPLIES[2]!,
    ]);
    expect(verdict.detected).toBe(true);
    expect(verdict.considered).toBe(3);
  });
});

describe("formatErrorLoopReport", () => {
  test("停止理由・回数・自動再投入しない旨を含む", () => {
    const verdict = detectErrorLoop(MOCK_REPLIES);
    const report = formatErrorLoopReport({
      worker: "sess-abc (tmux claude-thread)",
      verdict,
      lastError: MOCK_REPLIES[2]!,
      stopOutcome: "session-ctl stop exit=0 / sessions.db status=stopped",
    });
    expect(report).toContain("error loop");
    expect(report).toContain("sess-abc");
    expect(report).toContain(`${ERROR_LOOP_THRESHOLD} 回`);
    expect(report).toContain("EACCES");
    expect(report).toContain("session-ctl stop exit=0");
    // policy B-3: 別アプローチでの自動再投入はしない（L2 申し送り）。
    expect(report).toContain("自動再投入はしません");
  });
});

describe("assertIsolatedEnv", () => {
  const FIXTURE = resolve(
    import.meta.dir,
    "../e2e/fixtures/claude-error-loop-mock.sh",
  );

  function isolatedEnv(overrides: Record<string, string | undefined> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "e2e-el-guard-"));
    return {
      env: {
        SUPERVISOR_TMUX_SOCKET: "claude-hub-e2e-test",
        SUPERVISOR_DB_PATH: join(dir, "sessions.db"),
        XDG_RUNTIME_DIR: join(dir, "runtime"),
        SUPERVISOR_CLAUDE_PATH: FIXTURE,
        ...overrides,
      } as Record<string, string | undefined>,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("隔離済み env では通る", () => {
    const { env, cleanup } = isolatedEnv();
    try {
      expect(() => assertIsolatedEnv(env)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test("本番 tmux socket を拒否する（RW-019）", () => {
    const { env, cleanup } = isolatedEnv({ SUPERVISOR_TMUX_SOCKET: "claude-hub" });
    try {
      expect(() => assertIsolatedEnv(env)).toThrow(/claude-hub/);
    } finally {
      cleanup();
    }
  });

  test("SUPERVISOR_DB_PATH 未設定を拒否する（本番 sessions.db 保護）", () => {
    const { env, cleanup } = isolatedEnv({ SUPERVISOR_DB_PATH: undefined });
    try {
      expect(() => assertIsolatedEnv(env)).toThrow(/SUPERVISOR_DB_PATH/);
    } finally {
      cleanup();
    }
  });

  test(":memory: を拒否する（書き手と読み手で別 DB になるため）", () => {
    const { env, cleanup } = isolatedEnv({ SUPERVISOR_DB_PATH: ":memory:" });
    try {
      expect(() => assertIsolatedEnv(env)).toThrow(/memory/);
    } finally {
      cleanup();
    }
  });

  test("XDG_RUNTIME_DIR 未設定を拒否する（relay-port 上書き防止）", () => {
    const { env, cleanup } = isolatedEnv({ XDG_RUNTIME_DIR: undefined });
    try {
      expect(() => assertIsolatedEnv(env)).toThrow(/XDG_RUNTIME_DIR/);
    } finally {
      cleanup();
    }
  });

  test("SUPERVISOR_CLAUDE_PATH 未設定を拒否する（実 claude の課金防止）", () => {
    const { env, cleanup } = isolatedEnv({ SUPERVISOR_CLAUDE_PATH: undefined });
    try {
      expect(() => assertIsolatedEnv(env)).toThrow(/SUPERVISOR_CLAUDE_PATH/);
    } finally {
      cleanup();
    }
  });

  test("複数欠落はすべて列挙する（1 個直して再実行の往復を避ける）", () => {
    const { env, cleanup } = isolatedEnv({
      SUPERVISOR_TMUX_SOCKET: "claude-hub",
      SUPERVISOR_CLAUDE_PATH: undefined,
    });
    try {
      expect(() => assertIsolatedEnv(env)).toThrow(/RW-019|claude-hub/);
      let message = "";
      try {
        assertIsolatedEnv(env);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("SUPERVISOR_TMUX_SOCKET");
      expect(message).toContain("SUPERVISOR_CLAUDE_PATH");
    } finally {
      cleanup();
    }
  });
});
