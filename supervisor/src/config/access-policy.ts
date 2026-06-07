/**
 * Runtime enforcement of the Discord access policy (`~/.claude/channels/
 * discord/access.json`). Issue #32 / S7 (Critical).
 *
 * The supervisor relays Discord messages into Claude sessions that run with
 * `--dangerously-skip-permissions`. Before this module, the relay path
 * (`bot.ts` MessageCreate, `real-client.ts` MessageCreate, `commands/session.ts`
 * `handleStart`) never consulted `access.json`, so any user able to post in a
 * watched channel could drive a privileged Claude session (lateral movement).
 *
 * This module provides the **fail-closed** gate that those call sites evaluate
 * BEFORE relaying. The decision logic mirrors the upstream discord plugin's
 * `gate()` group path (claude-plugins-official/external_plugins/discord/
 * server.ts) so the supervisor and the channel server agree on who is allowed:
 *
 *   1. policy unavailable (missing / unparsable file)  -> DENY
 *   2. channel not present in `groups`                 -> DENY
 *   3. `groupAllowFrom` non-empty and sender absent    -> DENY
 *   4. `requireMention` (default true) and not mentioned -> DENY
 *   5. otherwise                                       -> ALLOW
 *
 * An empty `groupAllowFrom` means "any member of this channel" (subject to
 * `requireMention`), matching upstream and preserving the claudeHubExit primary
 * entry (`requireMention:false, allowFrom:[]`). The fail-closed default applies
 * only to *undefined* channels and *unavailable* policy — never silently
 * widening access.
 *
 * Reasons are coarse enum strings, never the raw user/channel snowflakes, so
 * structured denial logs cannot leak identifiers into transcripts.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Per-channel policy entry (keyed by Discord channel snowflake under `groups`). */
export interface GroupPolicy {
  /** When true (the default), the bot only acts on @mentions / replies. */
  requireMention?: boolean;
  /**
   * Sender snowflakes allowed to trigger this channel. Empty = any member
   * (still subject to `requireMention`).
   */
  allowFrom?: string[];
}

/** Minimal shape of access.json needed for runtime relay gating. */
export interface AccessPolicy {
  groups?: Record<string, GroupPolicy>;
  // Other keys (dmPolicy, allowFrom, pending, mentionPatterns, delivery config)
  // are intentionally not modeled here — relay gating only needs `groups`.
}

/** Coarse, non-identifying denial/allow reasons (safe to log). */
export type AccessDecisionReason =
  | "allowed"
  | "policy_unavailable"
  | "channel_not_configured"
  | "sender_not_allowlisted"
  | "mention_required";

export interface AccessDecision {
  allowed: boolean;
  reason: AccessDecisionReason;
}

/**
 * Canonical location of the live access policy. Overridable via
 * `SUPERVISOR_ACCESS_JSON_PATH` for tests and alternate deployments. Matches
 * `scripts/check-access-policy.ts` (`~/.claude/channels/discord/access.json`).
 */
export function defaultAccessJsonPath(): string {
  return (
    process.env.SUPERVISOR_ACCESS_JSON_PATH ??
    join(homedir(), ".claude", "channels", "discord", "access.json")
  );
}

/**
 * Pure decision function. `policy` may be `null` (unavailable) — that is an
 * explicit DENY (fail-closed), not an error. Never throws.
 */
export function isSenderAllowed(
  policy: AccessPolicy | null | undefined,
  channelKey: string,
  userId: string,
  isMention: boolean,
): AccessDecision {
  if (!policy || typeof policy !== "object") {
    return { allowed: false, reason: "policy_unavailable" };
  }

  const group = policy.groups?.[channelKey];
  if (!group) {
    // Channel not opted in (or no groups at all) -> fail-closed DENY.
    return { allowed: false, reason: "channel_not_configured" };
  }

  const groupAllowFrom = group.allowFrom ?? [];
  // Default requireMention to true (upstream default + fail-closed bias).
  const requireMention = group.requireMention ?? true;

  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(userId)) {
    return { allowed: false, reason: "sender_not_allowlisted" };
  }

  if (requireMention && !isMention) {
    return { allowed: false, reason: "mention_required" };
  }

  return { allowed: true, reason: "allowed" };
}

/**
 * Load and parse the access policy. Returns `null` when the file is missing,
 * unreadable, not valid JSON, or not a JSON object. A `null` return is the
 * fail-closed signal — callers must DENY. Never throws.
 */
export function loadAccessPolicy(
  path: string = defaultAccessJsonPath(),
): AccessPolicy | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Missing or unreadable file: fail-closed (no relay).
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON: fail-closed rather than guessing intent.
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as AccessPolicy;
}

export interface AccessQuery {
  channelKey: string;
  userId: string;
  isMention: boolean;
}

/**
 * Load the policy from disk and evaluate it in one call. This is the function
 * the runtime relay call sites use. Fail-closed: a `null` policy (missing /
 * broken file) yields `{ allowed: false, reason: "policy_unavailable" }`.
 */
export function evaluateAccess(
  query: AccessQuery,
  path: string = defaultAccessJsonPath(),
): AccessDecision {
  const policy = loadAccessPolicy(path);
  return isSenderAllowed(
    policy,
    query.channelKey,
    query.userId,
    query.isMention,
  );
}
