/**
 * Pure logic for verifying that `CHANNEL_MAP` (TypeScript source of truth)
 * stays in sync with the Discord access policy (`~/.claude/channels/discord/
 * access.json` for the live env, or `examples/access-policy.template.json`
 * for the committed CI snapshot). Issue #100.
 *
 * Two complementary checks:
 *
 * - {@link checkAccessPolicyCounts}: count-based, used against the live
 *   `access.json` whose keys are Discord channel IDs (not names). Catches
 *   "you added a channel to CHANNEL_MAP but forgot to add the matching
 *   group entry to access.json" by comparing counts.
 *
 * - {@link checkAccessPolicyTemplate}: name-based, used against a committed
 *   template whose keys are channel names. Catches the same mismatch in CI
 *   without requiring any real channel IDs to be committed (the live IDs
 *   are user-local and are not safe to publish).
 */

export interface CountCheckResult {
  inSync: boolean;
  expected: number;
  actual: number;
  diff: number;
}

export interface TemplateCheckResult {
  inSync: boolean;
  missingFromTemplate: string[];
  extraInTemplate: string[];
}

/**
 * Count-based check against the live `access.json`. Each `CHANNEL_MAP`
 * entry is expected to have a matching Discord group entry, plus
 * `primaryReserved` entries (default 1, for the claudeHubExit primary
 * channel that is intentionally not in `CHANNEL_MAP`).
 */
export function checkAccessPolicyCounts(
  channelMapSize: number,
  accessGroupCount: number,
  primaryReserved = 1,
): CountCheckResult {
  const expected = channelMapSize + primaryReserved;
  return {
    inSync: accessGroupCount === expected,
    expected,
    actual: accessGroupCount,
    diff: accessGroupCount - expected,
  };
}

/**
 * Name-based check against the committed template. The template's keys
 * (excluding any reserved primary key) must match `channelMapNames`
 * exactly — every CHANNEL_MAP entry must appear in the template, and no
 * stale template entries may remain.
 */
export function checkAccessPolicyTemplate(
  channelMapNames: readonly string[],
  templateKeys: readonly string[],
  primaryKey = "_claudeHubExitPrimary",
): TemplateCheckResult {
  const channelSet = new Set(channelMapNames);
  const filteredTemplate = templateKeys.filter((k) => k !== primaryKey);
  const templateSet = new Set(filteredTemplate);

  const missingFromTemplate = channelMapNames
    .filter((name) => !templateSet.has(name))
    .sort();
  const extraInTemplate = filteredTemplate
    .filter((name) => !channelSet.has(name))
    .sort();

  return {
    inSync:
      missingFromTemplate.length === 0 && extraInTemplate.length === 0,
    missingFromTemplate,
    extraInTemplate,
  };
}
