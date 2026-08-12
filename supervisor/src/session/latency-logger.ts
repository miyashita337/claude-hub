import { appendFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { homedir, loadavg } from "os";

/**
 * Append-only logger for supervisor relay segment latencies.
 *
 * 各 relayMessage 呼出ごとに 1 行 JSON を `~/.claude/state/relay-latency-log.jsonl`
 * に追記し、Issue #135 / Epic #101 の高負荷時 70s+ 遅延の dominant 要因特定に
 * 使う。観測コストを抑えるため fail-open: 書き込み失敗は warn のみで握りつぶす
 * (relay 本来の責務を阻害しない、RW-023 にあるように consumer 側で「ログが
 * 書かれていない」ことを定期検出する)。
 *
 * Consumer: `scripts/analyze-relay-latency.sh` (segment 別 median 集計 + dominant 表示)
 *
 * @see Issue #135, Epic #101, rules/general/observability.md「consumer 必須」
 */

export const DEFAULT_LATENCY_LOG_PATH = resolve(
  homedir(),
  ".claude",
  "state",
  "relay-latency-log.jsonl"
);

/** Segment ID → 名称のマッピング (Issue #135 本文の (a)〜(f) に対応) */
export const SEGMENT_NAMES = {
  a: "discord_to_relay_entry",
  b: "tmux_send_keys",
  c: "tmux_send_complete_to_wait_start",
  d_e_c: "wait_for_relay_response",
  f: "discord_reply_complete",
} as const;

export interface RelayLatencyRecord {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** supervisor session id (tmux session name 等の安定識別子) */
  session_id: string;
  /** load_avg_1m at measurement time */
  load_avg_1m: number;
  /** segment ms, key は SEGMENT_NAMES のキーと同じ */
  segments: Partial<Record<keyof typeof SEGMENT_NAMES, number>>;
  /** 全体所要時間 (ms)。segments の単純合計とは限らない (overlap 等) */
  total_ms: number;
  /** error 発生 segment 名 (success 時は undefined) */
  error_segment?: string;
  /**
   * この relay ターンの応答がユーザーに届いたか (Issue #223)。
   *
   * true = 応答 chunk を返せた / false = tmux 送信失敗 or relay 待ち失敗で届かず。
   * 「届いたか」の二値だけを持つ: 失敗の内訳は既に error_segment ("b" = 送信失敗、
   * "d_e_c" = 待ち失敗) が持っており、欠けていたのは二値化と日次到達率の算出手段
   * だけだったため (Issue #223 の設計)。
   *
   * optional なのは #223 以前に書かれた行との互換のため。consumer
   * (scripts/analyze-relay-latency.sh) は field を持つ行だけを attempts に数え、
   * 旧行が到達率を薄めないようにしている。
   */
  delivered?: boolean;
}

let logPath = DEFAULT_LATENCY_LOG_PATH;
let initialized = false;

/**
 * テスト用にログ出力先を上書きする。本番コードでは呼ばない。
 */
export function setLatencyLogPath(path: string): void {
  logPath = path;
  initialized = false;
}

export function getLatencyLogPath(): string {
  return logPath;
}

/**
 * 1 計測分を 1 行 JSON で append する。
 * Fail-open: I/O エラーは warn ログのみで握りつぶす。
 */
export function recordRelayLatency(record: RelayLatencyRecord): void {
  try {
    if (!initialized) {
      mkdirSync(dirname(logPath), { recursive: true });
      initialized = true;
    }
    const line = JSON.stringify(record) + "\n";
    appendFileSync(logPath, line, { encoding: "utf8" });
  } catch (err) {
    // 観測機構の失敗が relay 本来のフローに影響しないよう、warn のみ。
    // consumer 側 (analyze-relay-latency.sh) で「ログが書かれていない」を検出する。
    console.warn(
      "[latency-logger] recordRelayLatency failed (non-fatal):",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 計測補助: 各 segment 開始時刻と終了時刻を保持して record を組み立てる。
 *
 * 使い方:
 *   const tracker = createLatencyTracker(sessionId);
 *   tracker.markStart("b");
 *   ... tmux send ...
 *   tracker.markEnd("b");
 *   ...
 *   tracker.flush();
 */
export interface LatencyTracker {
  markStart(segment: keyof typeof SEGMENT_NAMES): void;
  markEnd(segment: keyof typeof SEGMENT_NAMES): void;
  setError(segment: string): void;
  /**
   * この relay ターンが応答を届けられたかを記録する (Issue #223)。
   * flush() の前に呼ぶ。呼ばなければ delivered field は出力されない。
   */
  setDelivered(ok: boolean): void;
  flush(): RelayLatencyRecord;
}

export function createLatencyTracker(sessionId: string): LatencyTracker {
  const startTimes = new Map<string, number>();
  const segments: Partial<Record<keyof typeof SEGMENT_NAMES, number>> = {};
  const trackerStart = performance.now();
  let errorSegment: string | undefined;
  let delivered: boolean | undefined;

  return {
    markStart(segment) {
      startTimes.set(segment, performance.now());
    },
    markEnd(segment) {
      const start = startTimes.get(segment);
      if (start === undefined) {
        // markStart を呼ばずに markEnd した場合は無視 (壊れた測定にしない)
        return;
      }
      segments[segment] = Math.round(performance.now() - start);
    },
    setError(segment) {
      errorSegment = segment;
    },
    setDelivered(ok) {
      delivered = ok;
    },
    flush() {
      const record: RelayLatencyRecord = {
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        load_avg_1m: Math.round((loadavg()[0] ?? 0) * 100) / 100,
        segments,
        total_ms: Math.round(performance.now() - trackerStart),
      };
      if (errorSegment) {
        record.error_segment = errorSegment;
      }
      if (delivered !== undefined) {
        record.delivered = delivered;
      }
      recordRelayLatency(record);
      return record;
    },
  };
}
