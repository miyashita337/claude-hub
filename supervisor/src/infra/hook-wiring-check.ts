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
// Deliberately WARN-only (console + return value), never fatal: a missing
// hook degrades UX but the supervisor itself is healthy, and a config-parse
// hiccup must not take the bot down (defensive-programming: fail soft on the
// observability path).

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface RequiredHook {
  /** Hook event name as it appears in settings.json (e.g. "PreToolUse"). */
  event: string;
  /** Path suffix of the hook script, matched against each command string. */
  scriptSuffix: string;
}

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
  { event: "PreToolUse", scriptSuffix: "supervisor/hooks/ask-user-relay.sh" },
];

interface HookEntry {
  command?: unknown;
}

interface MatcherGroup {
  hooks?: unknown;
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
  const hooks =
    settings && typeof settings === "object"
      ? (settings as { hooks?: unknown }).hooks
      : undefined;
  const events =
    hooks && typeof hooks === "object"
      ? (hooks as Record<string, unknown>)
      : {};

  return required.filter((req) => {
    const groups = events[req.event];
    if (!Array.isArray(groups)) return true;
    const commands = groups.flatMap((group: MatcherGroup) =>
      Array.isArray(group?.hooks)
        ? group.hooks.map((h: HookEntry) =>
            typeof h?.command === "string" ? h.command : ""
          )
        : []
    );
    return !commands.some((cmd) => cmd.includes(req.scriptSuffix));
  });
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

  return findMissingHookWiring(parsed).map(
    (req) =>
      `[HookWiring] ${req.scriptSuffix} が ${req.event} に未配線です。` +
      `Discord 中継が欠けます — ${settingsPath} の hooks.${req.event} に登録してください（Issue #370 D1 の再発）。`
  );
}
