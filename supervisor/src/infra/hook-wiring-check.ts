// supervisor/src/infra/hook-wiring-check.ts (Issue #370 A-2)
//
// Machine check for "the hook file exists but nobody wired it into settings".
// ask-user-relay.sh sat unwired for ~5 months because nothing verified the
// wiring: `scripts/check-stale-assets.sh` looks for assets with zero
// references, but this hook HAD references (tests, docs) — it was referenced
// yet unreachable. This module closes that gap: bot startup reads the user's
// ~/.claude/settings.json and warns about every supervisor relay hook that is
// not registered under its required event.
//
// Issue #416 extends it from "is the hook wired?" to "is it wired *usefully*?".
// The ask relay's wait is the minimum of four layers, and the fourth — Claude
// Code's per-hook `timeout` — is the one layer that lives outside this
// repository, so raising the other three here silently achieves nothing. That
// is not hypothetical: settings.json carried `timeout: 320` from Issue #255,
// which would cap a 5-hour wait at 5 minutes 20 seconds with no error anywhere.
//
// Deliberately WARN-only (console + return value), never fatal: a missing
// hook degrades UX but the supervisor itself is healthy, and a config-parse
// hiccup must not take the bot down (defensive-programming: fail soft on the
// observability path).

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DEFAULT_ASK_TIMEOUT_MS, MAX_ASK_TIMEOUT_MS } from "../session/relay-server";

export interface RequiredHook {
  /** Hook event name as it appears in settings.json (e.g. "PreToolUse"). */
  event: string;
  /** Path suffix of the hook script, matched against each command string. */
  scriptSuffix: string;
  /**
   * Minimum `timeout` this hook needs, in SECONDS (the unit settings.json uses).
   * Claude Code kills a command hook at this value, so for a hook that waits on
   * a human it is a hard ceiling on the wait regardless of what the supervisor
   * allows. Absent = the hook returns promptly and no requirement applies.
   */
  minTimeoutSec?: number;
}

/**
 * Seconds the AskUserQuestion hook must be allowed to run (Issue #416).
 * Derived from the server's own default rather than restated, because a second
 * copy of this number is exactly how the "約 5 分" notice and the 320s hook
 * timeout both outlived the value they described.
 */
export const ASK_HOOK_MIN_TIMEOUT_SEC = Math.ceil(DEFAULT_ASK_TIMEOUT_MS / 1000);

/**
 * Value to recommend in the warning: the server's hard cap (which is also the
 * curl budget in ask-user-relay.sh) plus a minute of headroom. Covers every
 * reachable `ASK_TIMEOUT_MS` in one go, so the user never has to revisit it,
 * and the headroom keeps Claude Code from killing the hook at the exact instant
 * curl is giving up — at equal values the two race, and losing the race throws
 * away an answer that had already arrived.
 */
export const ASK_HOOK_RECOMMENDED_TIMEOUT_SEC =
  Math.ceil(MAX_ASK_TIMEOUT_MS / 1000) + 60;

/**
 * Claude Code's `timeout` default for a command hook when settings.json omits
 * it, in seconds (out: code.claude.com/docs/en/hooks — "60 seconds" for
 * SessionEnd, 600 for command hooks generally). Omitting the field is therefore
 * NOT "no limit": it is 10 minutes, which is short of the ask budget too.
 */
const CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_SEC = 600;

/**
 * Relay hooks the supervisor cannot work without. Each must appear as a
 * command under its event in ~/.claude/settings.json (any matcher).
 */
export const REQUIRED_SUPERVISOR_HOOKS: RequiredHook[] = [
  { event: "PostToolUse", scriptSuffix: "supervisor/hooks/progress-relay.sh" },
  { event: "Stop", scriptSuffix: "supervisor/hooks/stop-relay.sh" },
  {
    event: "PermissionRequest",
    scriptSuffix: "supervisor/hooks/auto-approve-permission.sh",
  },
  {
    event: "PreToolUse",
    scriptSuffix: "supervisor/hooks/ask-user-relay.sh",
    minTimeoutSec: ASK_HOOK_MIN_TIMEOUT_SEC,
  },
];

interface HookEntry {
  command?: unknown;
  timeout?: unknown;
}

interface MatcherGroup {
  hooks?: unknown;
}

/** Every hook entry registered under `event`, flattened across matcher groups. */
function entriesForEvent(settings: unknown, event: string): HookEntry[] {
  const hooks =
    settings && typeof settings === "object"
      ? (settings as { hooks?: unknown }).hooks
      : undefined;
  const events =
    hooks && typeof hooks === "object"
      ? (hooks as Record<string, unknown>)
      : {};
  const groups = events[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: MatcherGroup) =>
    Array.isArray(group?.hooks) ? (group.hooks as HookEntry[]) : []
  );
}

/** Entries under `event` whose command mentions `scriptSuffix`. */
function matchingEntries(settings: unknown, req: RequiredHook): HookEntry[] {
  return entriesForEvent(settings, req.event).filter(
    (h) => typeof h?.command === "string" && h.command.includes(req.scriptSuffix)
  );
}

/**
 * Pure check: which required hooks are missing from a parsed settings object?
 * Exported separately from the file-reading wrapper so tests can exercise the
 * matching logic against fixtures without touching the real home directory.
 */
export function findMissingHookWiring(
  settings: unknown,
  required: RequiredHook[] = REQUIRED_SUPERVISOR_HOOKS
): RequiredHook[] {
  return required.filter((req) => matchingEntries(settings, req).length === 0);
}

/** A wired hook whose configured `timeout` is below what it needs (#416). */
export interface HookTimeoutShortfall {
  hook: RequiredHook;
  /** Effective ceiling in seconds — the configured value, or Claude Code's default. */
  effectiveSec: number;
  /** True when settings.json omitted `timeout` and the default applies. */
  implicit: boolean;
}

/**
 * Pure check: which wired hooks would be killed before they can finish
 * waiting? Only hooks declaring `minTimeoutSec` are considered, and only when
 * they ARE wired — an unwired hook is already reported by
 * {@link findMissingHookWiring} and does not need a second warning.
 *
 * When several entries match the same script (duplicated wiring), the most
 * generous one wins: Claude Code runs each registration independently, so one
 * of them completing the wait is enough.
 */
export function findHookTimeoutShortfalls(
  settings: unknown,
  required: RequiredHook[] = REQUIRED_SUPERVISOR_HOOKS
): HookTimeoutShortfall[] {
  const shortfalls: HookTimeoutShortfall[] = [];

  for (const hook of required) {
    if (hook.minTimeoutSec === undefined) continue;
    const entries = matchingEntries(settings, hook);
    if (entries.length === 0) continue;

    let effectiveSec = 0;
    let implicit = true;
    for (const entry of entries) {
      const configured =
        typeof entry.timeout === "number" && Number.isFinite(entry.timeout)
          ? entry.timeout
          : null;
      const sec = configured ?? CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_SEC;
      if (sec > effectiveSec) {
        effectiveSec = sec;
        implicit = configured === null;
      }
    }

    if (effectiveSec < hook.minTimeoutSec) {
      shortfalls.push({ hook, effectiveSec, implicit });
    }
  }

  return shortfalls;
}

/**
 * Read the user's settings file and return human-readable warnings for every
 * missing wiring (empty array = all wired). Never throws.
 */
export function checkHookWiring(
  settingsPath: string = join(homedir(), ".claude", "settings.json")
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (err) {
    return [
      `[HookWiring] ${settingsPath} を読めないため配線検証をスキップしました: ${String(err)}`,
    ];
  }

  const warnings = findMissingHookWiring(parsed).map(
    (req) =>
      `[HookWiring] ${req.scriptSuffix} が ${req.event} に未配線です。` +
      `Discord 中継が欠けます — ${settingsPath} の hooks.${req.event} に登録してください（Issue #370 D1 の再発）。`
  );

  for (const { hook, effectiveSec, implicit } of findHookTimeoutShortfalls(
    parsed,
  )) {
    warnings.push(
      `[HookWiring] ${hook.scriptSuffix} の hook timeout が ${effectiveSec} 秒` +
        `${implicit ? "（timeout 未指定のため Claude Code の既定値）" : ""}で、` +
        `必要な ${hook.minTimeoutSec} 秒に足りません。` +
        `回答待ちはこの値で打ち切られるため、supervisor 側を伸ばしても効きません — ` +
        `${settingsPath} の hooks.${hook.event} 該当エントリに ` +
        `"timeout": ${ASK_HOOK_RECOMMENDED_TIMEOUT_SEC} を設定してください（Issue #416）。`,
    );
  }

  return warnings;
}
