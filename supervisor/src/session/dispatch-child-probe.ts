import { execFile } from "child_process";
import { promisify } from "util";
import { TMUX_PATH, TMUX_ARGS } from "./tmux";

const execFileAsync = promisify(execFile);

/**
 * Child-process probe for the dispatch health reaper (Issue #279).
 *
 * A dispatch session that has gone silent (no relay activity for the health
 * horizon) is only safe to auto-reap if it is *genuinely* idle. A session
 * blocked on a long CI/build/test/push run produces no relay traffic either —
 * it looks identical to a dead one from `lastActivityAt` alone — but reaping it
 * kills work mid-flight: {@link import("./manager").SessionManager.stop} removes
 * the per-branch worktree, discarding any uncommitted output.
 *
 * This module walks the process subtree rooted at the session's tmux pane and
 * asks a single question: is there a live build/CI/test/push descendant? The
 * answer gates the reaper:
 *   - `busy`    → a recognised tool is running → SPARE (keep nudging via #209),
 *   - `idle`    → only the agent + shells remain → safe to reap,
 *   - `unknown` → the pane pid or process table could not be read → SPARE
 *     (fail-safe: "迷ったら止めない"; the 48h orphan reaper is the backstop).
 *
 * The danger is asymmetric — a false `idle` reaps a working session, a false
 * `busy` only delays reaping — so {@link BUSY_COMMAND_RE} is deliberately
 * generous toward `busy`, and the agent runtime / shells (`claude`, plain
 * `node`/`bun`, `-zsh`) are intentionally NOT matched (they are always present
 * and would pin every session to `busy` forever, defeating auto-reap).
 *
 * All shell access ({@link RealProbeDeps}) is injectable so the pure matching /
 * tree-walking logic is unit-tested without spawning `ps` or `tmux`.
 */

export type BusyProbeResult = "busy" | "idle" | "unknown";

/** One row of the process table the probe reads (pid, parent pid, command). */
export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * Commands whose presence in a session's subtree means "actively working".
 * Subcommand-qualified where a bare binary would be ambiguous (`bun`/`npm` name
 * the runtime the agent itself runs on, so only `bun test` / `npm run` etc. —
 * an actual invocation — count). Extend generously: a missed pattern risks
 * reaping a working session, the far worse failure (see module doc).
 */
export const BUSY_COMMAND_RE =
  /(\bcargo\b|\b(vitest|jest|mocha|playwright|cypress|pytest)\b|\btsc\b|\btsx\b|\beslint\b|\bbiome\b|\bgh\s+(run|pr|workflow)\b|\bgit\s+(push|fetch|pull|clone)\b|\b(npm|pnpm|yarn)\s+(run|test|ci|install|build|exec)\b|\bbun\s+(test|run|x|install|build)\b|\bmake\b|\b(vite|webpack|esbuild|rollup|turbo)\b|\bdocker\b)/;

/**
 * Parse `ps -o pid=,ppid=,command=` output. Each line is `<pid> <ppid> <cmd…>`;
 * lines that do not start with two integers (blank / header / wrapped) are
 * skipped. The command captures the remainder verbatim (may contain spaces).
 */
export function parsePsOutput(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return rows;
}

/**
 * All transitive descendants of `rootPid` (excluding the root itself). Iterative
 * DFS with a visited set so a malformed ppid cycle in the table cannot hang the
 * walk.
 */
export function collectDescendants(rootPid: number, rows: ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid);
    if (list) list.push(r);
    else byParent.set(r.ppid, [r]);
  }
  const out: ProcRow[] = [];
  const seen = new Set<number>([rootPid]);
  const stack: number[] = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/** True iff any descendant of `rootPid` matches {@link BUSY_COMMAND_RE}. */
export function hasBusyDescendant(rootPid: number, rows: ProcRow[]): boolean {
  return collectDescendants(rootPid, rows).some((r) =>
    BUSY_COMMAND_RE.test(r.command)
  );
}

/**
 * Pure classification. A null pane pid (tmux gone / unreadable) or a null
 * process table (ps failed) is `unknown` — the fail-safe that spares the
 * session. Otherwise `busy` when a build/CI/test descendant is live, else
 * `idle`.
 */
export function classifyProbe(
  panePid: number | null,
  rows: ProcRow[] | null
): BusyProbeResult {
  if (panePid == null || rows == null) return "unknown";
  return hasBusyDescendant(panePid, rows) ? "busy" : "idle";
}

export interface RealProbeDeps {
  /** Resolve the tmux pane's root pid for a session name. Null when unreadable. */
  getPanePid?: (tmuxSessionName: string) => Promise<number | null>;
  /** Snapshot the process table. Null when the listing fails. */
  listProcesses?: () => Promise<ProcRow[] | null>;
}

const PROBE_TIMEOUT_MS = 3000;

async function defaultGetPanePid(tmuxSessionName: string): Promise<number | null> {
  // Same shape as adapters.ts getPid(): first pane's #{pane_pid}. Any failure
  // (no server, timeout, no such session) collapses to null → unknown → spare.
  try {
    const { stdout } = await execFileAsync(
      TMUX_PATH,
      [...TMUX_ARGS, "list-panes", "-t", tmuxSessionName, "-F", "#{pane_pid}"],
      { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }
    );
    const pid = parseInt(stdout.trim().split("\n")[0] ?? "", 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function defaultListProcesses(): Promise<ProcRow[] | null> {
  // BSD ps (macOS): -A all processes, -ww no column-width truncation so long
  // command lines (the CI invocations we match) are not cut off. `=` headers
  // give a header-less table parsePsOutput can consume directly.
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-A", "-ww", "-o", "pid=,ppid=,command="],
      { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
    );
    return parsePsOutput(stdout);
  } catch {
    return null;
  }
}

/**
 * Production probe: resolve the pane pid for `<claude-…>` (derived by the
 * caller), snapshot the process table, and classify. Deps are injectable so the
 * reaper's tests never shell out.
 */
export async function realBusyChildProbe(
  tmuxSessionName: string,
  deps: RealProbeDeps = {}
): Promise<BusyProbeResult> {
  const getPanePid = deps.getPanePid ?? defaultGetPanePid;
  const listProcesses = deps.listProcesses ?? defaultListProcesses;
  const panePid = await getPanePid(tmuxSessionName);
  if (panePid == null) return "unknown";
  const rows = await listProcesses();
  return classifyProbe(panePid, rows);
}
