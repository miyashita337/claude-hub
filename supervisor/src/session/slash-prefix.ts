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

let cachedUserCommands: ReadonlySet<string> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

function defaultLoadUserCommands(): ReadonlySet<string> {
  const now = Date.now();
  if (cachedUserCommands && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedUserCommands;
  }
  const dir = join(homedir(), ".claude", "commands");
  const set = new Set<string>();
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      // Skip editor backup files like `foo.bak.md` that might be present.
      if (name.endsWith(".bak.md")) continue;
      const cmd = name.slice(0, -3);
      if (cmd) set.add(cmd);
    }
  } catch {
    // ENOENT or permission error: treat as empty allowlist. The strip path
    // will still fire on built-ins that don't appear in this dir, but the
    // BUILTIN_COMMANDS set above covers that.
  }
  cachedUserCommands = set;
  cacheLoadedAt = now;
  return cachedUserCommands;
}

/**
 * Returns true if `text` starts with a known slash command — either a Claude
 * Code built-in or a user-scope custom command from `~/.claude/commands/`.
 * `loader` is injectable so tests can stub the filesystem read.
 */
export function isKnownSlashCommand(
  text: string,
  loader: () => ReadonlySet<string> = defaultLoadUserCommands,
): boolean {
  const match = text.match(SLASH_NAME_RE);
  if (!match) return false;
  const name = match[1];
  if (!name) return false;
  if (BUILTIN_COMMANDS.has(name)) return true;
  return loader().has(name);
}

// Test helper.
export function _resetUserCommandCache(): void {
  cachedUserCommands = null;
  cacheLoadedAt = 0;
}
