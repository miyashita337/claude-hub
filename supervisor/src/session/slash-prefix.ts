import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Detect leading `/<command>` patterns (Claude Code TUI slash command style)
 * at message start and strip the leading `/` so the TUI doesn't enter
 * slash-picker mode.
 *
 * Issue #86: Forwarding `/<typo>` via tmux send-keys puts Claude Code's Ink
 * TUI into the slash-command picker. If the command is a typo
 * (e.g. `/hanle-review`) the picker stays open silently, the relay queue
 * hangs until RELAY_TIMEOUT_MS, and the bot looks idle.
 *
 * Issue #86 follow-up: Stripping ALL `/<word>` was too aggressive — legitimate
 * custom commands like `/save-session` got rewritten and ran via skill
 * matching only by coincidence. We now keep an allowlist of known commands
 * (built-ins + `~/.claude/commands/*.md`) and only strip the unknown ones.
 *
 * Issue #155 (#86 follow-up A): The allowlist only knew about user-global
 * commands (`~/.claude/commands/`), so a session's PROJECT-scoped command
 * (`<projectDir>/.claude/commands/*.md`, e.g. team_salary's `/write-article`)
 * was wrongly judged "unknown" and demoted to natural language. We now also
 * consult the project command dir for the session's cwd. Project commands are
 * cached per `projectDir` (each thread can run in a different cwd/worktree),
 * never in the single user-global cache, to avoid cross-project leakage.
 * Plugin- and skill-sourced commands are out of scope here (fragile,
 * version-dependent discovery paths) and tracked as a follow-up.
 *
 * The match is intentionally narrow: a path like `/usr/bin/ls` or
 * `/Users/x/foo` does NOT match because the first token is followed by `/`,
 * not whitespace or end-of-string.
 */
const SLASH_PREFIX_RE = /^\/[A-Za-z][A-Za-z0-9_-]*(?:\s|$)/;
const SLASH_NAME_RE = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/;

export function looksLikeSlashCommand(text: string): boolean {
  return SLASH_PREFIX_RE.test(text);
}

export function stripLeadingSlash(text: string): string {
  // looksLikeSlashCommand guarantees a leading `/`, so slice(1) is a
  // direct char-drop without the cost of a regex compile (PR #115 nitpick).
  return looksLikeSlashCommand(text) ? text.slice(1) : text;
}

/**
 * Conservative list of Claude Code built-in slash commands we should never
 * strip. Drawn from `claude --help` and public docs; if a built-in is missing
 * here, the worst case is the typo-protection kicks in once and the user can
 * retype — strictly safer than over-allowing.
 */
const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  "add-dir",
  "agents",
  "bug",
  "clear",
  "compact",
  "config",
  "context",
  "cost",
  "doctor",
  "exit",
  "export",
  "fast",
  "help",
  "hooks",
  "ide",
  "init",
  "install-github-app",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "permissions",
  "plan",
  "pr_comments",
  "release-notes",
  "resume",
  "review",
  "save",
  "security-review",
  "status",
  "statusline",
  "terminal-setup",
  "tools",
  "upgrade",
  "vim",
]);

const CACHE_TTL_MS = 60_000;
const EMPTY_COMMAND_SET: ReadonlySet<string> = new Set();
const emptyCommandLoader = (): ReadonlySet<string> => EMPTY_COMMAND_SET;

/**
 * Read `*.md` command names from a `.claude/commands` directory.
 *
 * Returns the command-name set plus a `cacheable` flag: `true` on success or
 * ENOENT (a stable, empty-or-populated answer worth caching for the TTL
 * window), `false` on unexpected errors (EACCES, EMFILE, …) so the caller
 * retries on the next call instead of caching a transient empty result.
 */
function readCommandDir(dir: string): {
  set: ReadonlySet<string>;
  cacheable: boolean;
} {
  const set = new Set<string>();
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      // Skip editor backup files like `foo.bak.md` that might be present.
      if (name.endsWith(".bak.md")) continue;
      const cmd = name.slice(0, -3);
      if (cmd) set.add(cmd);
    }
    return { set, cacheable: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Dir doesn't exist (e.g., a project with no custom commands). Empty
      // allowlist is the right answer; cache it for the TTL window.
      return { set, cacheable: true };
    }
    // Unexpected error: don't cache an empty result so transient failures
    // self-heal on the next call.
    console.warn(
      `[slash-prefix] Failed to read ${dir}: code=${code ?? "unknown"} message=${(err as Error).message ?? "n/a"}`,
    );
    return { set, cacheable: false };
  }
}

let cachedUserCommands: ReadonlySet<string> | null = null;
let cacheLoadedAt = 0;

function defaultLoadUserCommands(): ReadonlySet<string> {
  const now = Date.now();
  if (cachedUserCommands && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedUserCommands;
  }
  const dir = join(homedir(), ".claude", "commands");
  const { set, cacheable } = readCommandDir(dir);
  if (cacheable) {
    cachedUserCommands = set;
    cacheLoadedAt = now;
    return cachedUserCommands;
  }
  // Return the previous cache if any, else an empty set for this single call.
  return cachedUserCommands ?? set;
}

interface CommandCacheEntry {
  set: ReadonlySet<string>;
  loadedAt: number;
}

// Per-projectDir cache. Each thread can run in a different cwd/worktree, so a
// single shared cache (like the user-global one) would mis-attribute one
// project's commands to another. Bounded by PROJECT_CACHE_MAX to avoid
// unbounded growth in the long-lived Supervisor as worktree paths churn
// (cf. RW-039 worktree path proliferation).
const PROJECT_CACHE_MAX = 64;
const projectCommandCache = new Map<string, CommandCacheEntry>();

/**
 * Returns the set of project-scoped command names defined under
 * `<projectDir>/.claude/commands/*.md`, cached per `projectDir` for the TTL
 * window. Exported so `bot.ts` can build a project loader for the session's
 * cwd, and so tests can exercise the real filesystem path.
 *
 * Trust boundary: `projectDir` is the session's recorded cwd — an
 * operator-configured channel dir (`config.dir`) or a per-branch worktree
 * whose path already passed the metachar guard in `resolveWorktreePath`
 * (RW-045). It is NOT raw Discord user input at this point. We only read a
 * directory listing and use the `*.md` basenames for set membership; nothing
 * here is executed, so the blast radius is a benign `readdirSync`.
 *
 * Deleted-worktree case (RW-046): if the cwd was removed, `readdirSync` hits
 * ENOENT → empty set → the command is treated as unknown and stripped, which
 * is the safe fallback (the picker would have nothing to run anyway).
 */
export function loadProjectCommands(projectDir: string): ReadonlySet<string> {
  const now = Date.now();
  const cached = projectCommandCache.get(projectDir);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.set;
  }
  const dir = join(projectDir, ".claude", "commands");
  const { set, cacheable } = readCommandDir(dir);
  if (cacheable) {
    if (
      projectCommandCache.size >= PROJECT_CACHE_MAX &&
      !projectCommandCache.has(projectDir)
    ) {
      // Simple bound: clear the whole map rather than track LRU. The next
      // lookups repopulate from disk within one TTL window. Safe under Bun's
      // single-threaded JS execution (no preemption between clear and set
      // below); the map can transiently reach PROJECT_CACHE_MAX entries.
      projectCommandCache.clear();
    }
    projectCommandCache.set(projectDir, { set, loadedAt: now });
    return set;
  }
  // Unexpected read error: reuse the stale entry if present, else empty.
  return cached?.set ?? set;
}

/**
 * Returns true if `text` starts with a known slash command — a Claude Code
 * built-in, a user-scope custom command from `~/.claude/commands/`, or a
 * project-scope command for the session's cwd.
 *
 * `loader` (user-global) and `projectLoader` (project-scoped) are injectable
 * so tests can stub the filesystem reads. `projectLoader` defaults to an empty
 * set, preserving the prior built-in + user-global behaviour for callers that
 * don't supply a project context.
 */
export function isKnownSlashCommand(
  text: string,
  loader: () => ReadonlySet<string> = defaultLoadUserCommands,
  projectLoader: () => ReadonlySet<string> = emptyCommandLoader,
): boolean {
  const match = text.match(SLASH_NAME_RE);
  if (!match) return false;
  const name = match[1];
  if (!name) return false;
  if (BUILTIN_COMMANDS.has(name)) return true;
  if (loader().has(name)) return true;
  return projectLoader().has(name);
}

// Test helper. Clears both the user-global and per-project caches.
export function _resetUserCommandCache(): void {
  cachedUserCommands = null;
  cacheLoadedAt = 0;
  projectCommandCache.clear();
}
