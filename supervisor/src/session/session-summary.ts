/**
 * Previous-session summary lookup for Discord thread surfacing (Issue #141).
 *
 * Root cause of #141: the "前回セッションの要約" is produced by an external
 * SessionStart hook (ECC `scripts/hooks/session-start.js`) that injects the
 * summary into Claude's *context* (invisible `additionalContext`). The Claude
 * Code TUI shows it collapsed, so `tmux capture-pane` — which is what the
 * Supervisor relays to Discord — only carries the "hook success" line, never
 * the summary body. The user therefore sees the hook ran but no summary.
 *
 * Fix (approach A, user-decided 2026-06-11): the Supervisor reads the matching
 * session summary file directly and posts it into the thread on start/resume.
 * This avoids depending on Claude echoing it and avoids TUI string matching
 * (RW-027 / RW-047 anti-pattern).
 *
 * Session files are written by ECC's session-end / the save-session skill into
 * `~/.claude/sessions` and `~/.claude/session-data` as `*-session.tmp`. They
 * carry a `**Worktree:**` header. The ECC `**Project:**` header is only the
 * worktree basename (a per-session hash), so the *worktree path* is the one
 * reliable signal for matching a session to a Supervisor-managed project.
 */

import { homedir } from "os";
import { join, sep } from "path";
import { readdirSync, statSync, readFileSync } from "fs";

const ECC_SUMMARY_START = "<!-- ECC:SUMMARY:START -->";
const ECC_SUMMARY_END = "<!-- ECC:SUMMARY:END -->";
const SESSION_FILE_SUFFIX = "-session.tmp";
const DEFAULT_MAX_AGE_DAYS = 30;

/** Discord's hard per-message limit is 2000; leave headroom for the header. */
const MAX_SUMMARY_CHARS = 1800;

export interface SessionSummaryResult {
  /** Extracted summary text (untruncated). */
  text: string;
  /** Absolute path of the source `*-session.tmp` file. */
  sourceFile: string;
  /** Why this file matched the project. */
  matchReason: "worktree-exact" | "project-nested";
}

export interface SummaryCandidate {
  path: string;
  content: string;
  mtimeMs: number;
}

/** Strip a trailing path separator so comparisons are boundary-safe. */
function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

/**
 * `child` is `parent` itself, or nested under it at a path boundary.
 * Boundary check prevents `/a/b-other` from matching parent `/a/b`.
 */
export function isPathUnder(child: string, parent: string): boolean {
  const c = stripTrailingSep(child);
  const p = stripTrailingSep(parent);
  if (!p) return false;
  return c === p || c.startsWith(p + sep) || c.startsWith(p + "/");
}

/** Read the `**Worktree:**` header value, or "" when absent. */
export function extractWorktree(content: string): string {
  const m = content.match(/\*\*Worktree:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() ?? "";
}

/**
 * Pull the summary text out of a session file. Prefers the ECC summary block
 * (`<!-- ECC:SUMMARY:START -->` … `<!-- ECC:SUMMARY:END -->`); falls back to
 * the whole trimmed file for non-ECC (save-session) formats.
 */
export function extractSummaryText(content: string): string {
  const start = content.indexOf(ECC_SUMMARY_START);
  const end = content.indexOf(ECC_SUMMARY_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(start + ECC_SUMMARY_START.length, end).trim();
  }
  return content.trim();
}

/**
 * Choose the newest session summary that belongs to the project. A candidate
 * matches when its `**Worktree:**` equals `projectDir` (exact) or is nested
 * under `repoRoot` (a per-branch worktree of the same repo). Returns null when
 * nothing matches — an explicit "no previous summary", not a silent failure.
 */
export function selectSummaryFromCandidates(
  candidates: SummaryCandidate[],
  opts: { projectDir: string; repoRoot: string }
): SessionSummaryResult | null {
  const projectDir = stripTrailingSep(opts.projectDir);
  const repoRoot = stripTrailingSep(opts.repoRoot);

  // Newest first; ties are deterministic by path so behavior is stable.
  const sorted = [...candidates].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)
  );

  for (const candidate of sorted) {
    const worktree = stripTrailingSep(extractWorktree(candidate.content));
    if (!worktree) continue;

    const exact = worktree === projectDir;
    const sameProject = exact || isPathUnder(worktree, repoRoot);
    if (!sameProject) continue;

    const text = extractSummaryText(candidate.content);
    if (!text) continue;

    return {
      text,
      sourceFile: candidate.path,
      matchReason: exact ? "worktree-exact" : "project-nested",
    };
  }

  return null;
}

/**
 * Directories to scan for session summaries. Overridable via
 * `SUPERVISOR_SESSION_SUMMARY_DIRS` (colon-separated) for tests / custom setups.
 */
export function getSummarySearchDirs(): string[] {
  const override = process.env.SUPERVISOR_SESSION_SUMMARY_DIRS;
  if (override && override.trim()) {
    return override.split(":").map((s) => s.trim()).filter(Boolean);
  }
  const home = homedir();
  return [
    join(home, ".claude", "sessions"),
    join(home, ".claude", "session-data"),
  ];
}

/**
 * Find the most relevant previous-session summary for a project by reading the
 * session-summary directories from disk. Returns null when none match.
 */
export function findPreviousSessionSummary(opts: {
  projectDir: string;
  repoRoot: string;
  searchDirs?: string[];
  nowMs?: number;
  maxAgeDays?: number;
}): SessionSummaryResult | null {
  const searchDirs = opts.searchDirs ?? getSummarySearchDirs();
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;

  const candidates: SummaryCandidate[] = [];
  for (const dir of searchDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Directory may not exist (fresh machine / CI) — skip it.
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(SESSION_FILE_SUFFIX)) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (nowMs - st.mtimeMs > maxAgeMs) continue;
        candidates.push({
          path: full,
          content: readFileSync(full, "utf8"),
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // Unreadable / vanished between readdir and stat — skip this one.
        continue;
      }
    }
  }

  return selectSummaryFromCandidates(candidates, {
    projectDir: opts.projectDir,
    repoRoot: opts.repoRoot,
  });
}

/** Build the Discord message, truncating to stay under the per-message limit. */
export function formatSummaryMessage(result: SessionSummaryResult): string {
  const header = "🗒️ **前回セッションの要約**\n";
  const budget = MAX_SUMMARY_CHARS - header.length;
  let body = result.text;
  if (body.length > budget) {
    body = body.slice(0, budget - 12).trimEnd() + "\n…（以下省略）";
  }
  return header + body;
}

/** Minimal structural type for a thread we can post into (avoids a discord.js dep here). */
export interface SummaryThread {
  send: (content: string) => Promise<unknown>;
}

/**
 * Surface the previous-session summary into the thread on start/resume
 * (Issue #141). Best-effort: a missing summary is the normal "no previous
 * session" case and is skipped. A genuine failure is logged (not swallowed)
 * and must never break session start/resume.
 *
 * Kept in this module (not commands/session.ts) so session.ts gains no new
 * try/catch — the #27 interaction-safety guard statically scans session.ts for
 * `catch … editReply` spans, and an unrelated catch there would false-positive.
 */
export async function postPreviousSummary(
  thread: SummaryThread,
  opts: { projectDir: string; repoRoot: string }
): Promise<void> {
  try {
    const summary = findPreviousSessionSummary(opts);
    if (summary) {
      await thread.send(formatSummaryMessage(summary));
    }
  } catch (err) {
    console.warn(
      `[Session] previous-summary surfacing failed (non-fatal):`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
