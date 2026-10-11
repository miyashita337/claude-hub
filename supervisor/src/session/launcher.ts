import { execFile } from "child_process";
import { promisify } from "util";
import { basename } from "path";

const execFileAsync = promisify(execFile);

/**
 * External launcher for `claude` (Issue #492), e.g. `ccorg proxy`.
 *
 * `SUPERVISOR_CLAUDE_LAUNCHER` replaces the `claude` binary in the three launch
 * sites (tmux start, tmux resume, headless): the launcher is exec'd with the
 * same argv and starts `claude` itself (claude-org looks it up on PATH). The
 * value is operator-controlled, same trust level as `SUPERVISOR_CLAUDE_PATH`;
 * it is split like a shell word list (whitespace, `'...'`, `"..."`, `\\ `) so a
 * path containing spaces can be quoted, and never passed through a shell unquoted.
 *
 * Rollout is gated by `SUPERVISOR_CLAUDE_LAUNCHER_SCOPE` (comma separated):
 *   - `all`              every session (stage 3)
 *   - `dispatch`         headless dispatch workers (stage 2)
 *   - `channel:<name>`   sessions of one channel (stage 1)
 * Unset scope means `all`; unsetting the launcher is the rollback.
 *
 * Because the launcher is the process the tmux pane / spawn() sees, the pid we
 * get is the launcher's (node), not claude's. {@link findClaudeDescendant}
 * resolves the real claude pid and {@link sumTreeRssKB} measures the whole tree.
 */

export interface LauncherContext {
  channelName: string;
  headless: boolean;
}

export function resolveLauncher(
  ctx: LauncherContext,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  const raw = env.SUPERVISOR_CLAUDE_LAUNCHER?.trim();
  if (!raw) return null;
  const scope = (env.SUPERVISOR_CLAUDE_LAUNCHER_SCOPE ?? "all")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const inScope =
    scope.includes("all") ||
    (ctx.headless && scope.includes("dispatch")) ||
    scope.includes(`channel:${ctx.channelName}`);
  return inScope ? splitLauncher(raw) : null;
}

/**
 * Split `SUPERVISOR_CLAUDE_LAUNCHER` into argv. Supports single quotes, double
 * quotes and backslash escapes (no variable or glob expansion), so
 * `"/Users/Test User/bin/ccorg" proxy` stays two words (Issue #494).
 *
 * Inside double quotes a backslash only escapes `\\` and `"` (the subset of the
 * POSIX shell rule that applies without `$`/backtick expansion); any other
 * backslash is a literal character, so `"/tmp/team\build/ccorg"` keeps its
 * backslash instead of collapsing to `/tmp/teambuild/ccorg` (PR #495 review).
 */
export function splitLauncher(raw: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (
        ch === "\\" &&
        quote === '"' &&
        (raw[i + 1] === "\\" || raw[i + 1] === '"')
      )
        cur += raw[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < raw.length) {
      cur += raw[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`SUPERVISOR_CLAUDE_LAUNCHER に閉じられていない引用符があります: ${raw}`);
  if (inWord) words.push(cur);
  return words;
}

/** POSIX single-quote a word so the tmux shell command cannot re-parse it. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Proxy banner printed by `claude-org proxy` on stderr:
 * `-> proxy 127.0.0.1:50171 (order: ..., strategy: ..., log: /tmp/.../proxy.log)`
 * (claude-org lib/proxy.js `proxyLaunch`).
 */
const PROXY_BANNER_RE =
  /^-> proxy 127\.0\.0\.1:(\d+) \(.*\blog: (\S+?)\)\s*$/m;

export interface ProxyBanner {
  port: number;
  logPath: string;
}

export function parseProxyBanner(text: string): ProxyBanner | null {
  const m = text.match(PROXY_BANNER_RE);
  return m ? { port: Number(m[1]), logPath: m[2]! } : null;
}

/**
 * Drop the banner line so it is not echoed as a failure reason in the dispatch
 * report (headless stderr tail is shown to the user on a non-zero exit).
 */
export function stripProxyBanner(text: string): string {
  return text.replace(new RegExp(PROXY_BANNER_RE.source + "\\n?", "gm"), "");
}

/**
 * Message the claude-org proxy answers with when no org can serve the request
 * (lib/proxy.js `refuse(clientRes, 503, ...)`). `dialog-detect`'s usage-limit
 * marker does not match it, so it gets its own detection.
 */
export const ALL_ORGS_EXHAUSTED_MARKER =
  /all orgs rate-limited or unreachable/i;

export interface ProcRow {
  pid: number;
  ppid: number;
  rssKB: number;
  comm: string;
}

/** Parse `ps -axo pid=,ppid=,rss=,comm=`; comm may contain spaces (macOS paths). */
export function parseProcTable(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKB: Number(m[3]),
      comm: m[4]!,
    });
  }
  return rows;
}

function descendants(rootPid: number, rows: ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid);
    if (list) list.push(r);
    else byParent.set(r.ppid, [r]);
  }
  const out: ProcRow[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/** Shallowest descendant of `rootPid` whose executable is `claude`. */
export function findClaudeDescendant(
  rootPid: number,
  rows: ProcRow[],
): number | null {
  // BFS order is not needed: claude's own children (tool subprocesses) are never
  // named `claude`, so the first match in the tree is the session's claude.
  const hit = descendants(rootPid, rows).find(
    (r) => basename(r.comm) === "claude",
  );
  return hit ? hit.pid : null;
}

/** Sum of RSS (KB) over `rootPid` and every descendant. */
export function sumTreeRssKB(rootPid: number, rows: ProcRow[]): number {
  const root = rows.find((r) => r.pid === rootPid);
  return (
    (root?.rssKB ?? 0) +
    descendants(rootPid, rows).reduce((sum, r) => sum + r.rssKB, 0)
  );
}

export async function listProcTable(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,rss=,comm="],
    { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parseProcTable(stdout);
}

/**
 * Poll until a `claude` descendant of `launcherPid` appears (the launcher
 * starts it after its own boot). Returns null on timeout so the caller can
 * degrade loudly instead of tracking the launcher's pid as if it were claude.
 */
export async function waitForClaudePid(
  launcherPid: number,
  opts: {
    attempts?: number;
    intervalMs?: number;
    list?: () => Promise<ProcRow[]>;
    /** Called before each poll (e.g. to capture the proxy banner meanwhile). */
    onAttempt?: () => Promise<void>;
  } = {},
): Promise<number | null> {
  const {
    attempts = 20,
    intervalMs = 250,
    list = listProcTable,
    onAttempt,
  } = opts;
  for (let i = 0; i < attempts; i++) {
    try {
      await onAttempt?.();
      const pid = findClaudeDescendant(launcherPid, await list());
      if (pid != null) return pid;
    } catch (err) {
      console.warn("[Launcher] process table read failed:", err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/** Pids currently in process group `pgid` (`ps -axo pid=,pgid=`). */
export async function listGroupPids(pgid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (m && Number(m[2]) === pgid) pids.push(Number(m[1]));
  }
  return pids;
}

export interface ReapOptions {
  /** The claude pid when known (tmux_exited path); signalled directly too. */
  claudePid?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  members?: (pgid: number) => Promise<number[]>;
  attempts?: number;
  intervalMs?: number;
}

/**
 * Issue #494 (PR #495 Devin must): reap what a launcher left behind.
 *
 * When the launcher dies right after spawning `claude` (bad path, ccorg crash)
 * or its tmux pane goes away, the OS re-parents the still-running claude to
 * init: it is no longer a descendant of `launcherPid`, so neither
 * {@link findClaudeDescendant} nor the launcher-rooted RSS tree sees it, and
 * nothing would ever stop it. The process GROUP survives its leader, though:
 * the tmux pane and the headless `detached` spawn both make the launcher a
 * group leader, and claude-org starts claude without detaching, so
 * `kill(-launcherPid)` still reaches claude (and its tool children) after the
 * launcher is gone. `claudePid`, when the caller knows it, is signalled as
 * well in case claude moved to its own group.
 *
 * Best effort: an empty group / a dead pid is ESRCH and ignored. SIGTERM
 * first (claude flushes its transcript on it), SIGKILL for whatever is still
 * there after the wait. Returns the pids that survived even that (empty =
 * clean) so the caller can log them, or null when the group could not be
 * observed at all (`ps` failure) — unverified, not clean.
 */
export async function reapLauncherGroup(
  launcherPid: number,
  opts: ReapOptions = {},
): Promise<number[] | null> {
  const {
    claudePid,
    kill = (pid, signal) => process.kill(pid, signal),
    isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    members = listGroupPids,
    attempts = 20,
    intervalMs = 100,
  } = opts;
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      kill(pid, sig);
    } catch {
      // ESRCH (nothing left in the group / pid already gone) or EPERM: there
      // is nothing more this process can do about it.
    }
  };
  const sweep = (sig: NodeJS.Signals) => {
    signal(-launcherPid, sig);
    if (claudePid != null && claudePid !== launcherPid) signal(claudePid, sig);
  };
  const survivors = async (): Promise<number[]> => {
    const left = new Set<number>(await members(launcherPid));
    if (claudePid != null && isAlive(claudePid)) left.add(claudePid);
    return [...left];
  };
  // null = the group could not be observed (`ps` failed / timed out under
  // load). That is NOT "clean": the caller must not skip the SIGKILL sweep or
  // log a verified reap on it.
  const waitGone = async (): Promise<number[] | null> => {
    let left: number[] = [];
    for (let i = 0; i < attempts; i++) {
      try {
        left = await survivors();
      } catch (err) {
        console.warn("[Launcher] process group read failed during reap:", err);
        return null;
      }
      if (left.length === 0) return [];
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return left;
  };

  sweep("SIGTERM");
  let left = await waitGone();
  if (left !== null && left.length === 0) return [];
  console.warn(
    left === null
      ? `[Launcher] process group ${launcherPid} could not be observed after SIGTERM; sending SIGKILL unverified`
      : `[Launcher] process group ${launcherPid} still has ${left.join(", ")} after SIGTERM; sending SIGKILL`,
  );
  sweep("SIGKILL");
  left = await waitGone();
  return left;
}
