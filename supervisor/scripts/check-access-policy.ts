#!/usr/bin/env bun
/**
 * Verify CHANNEL_MAP stays in sync with the Discord access policy.
 * Issue #100.
 *
 * Modes:
 *
 * - default (no flag): local check against `~/.claude/channels/discord/
 *   access.json`. Uses count-based comparison because access.json keys
 *   are Discord channel IDs, not names. Reports missing or extra group
 *   entries as a warning.
 *
 * - `--ci`: name-based check against the committed
 *   `examples/access-policy.template.json`. Used by GitHub Actions on
 *   every push / PR. Fails if CHANNEL_MAP and the template's channel-name
 *   keys diverge. Real Discord IDs are never committed.
 *
 * Exit codes:
 *   0 — in sync
 *   1 — mismatch detected
 *   2 — configuration error (missing or unparseable file)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { CHANNEL_MAP } from "../src/config/channels";
import {
  checkAccessPolicyCounts,
  checkAccessPolicyTemplate,
} from "../src/config/check-access-policy-core";

const ACCESS_JSON_PATH = join(
  homedir(),
  ".claude",
  "channels",
  "discord",
  "access.json",
);

// repo-root/examples/access-policy.template.json
const TEMPLATE_PATH = resolve(
  import.meta.dir,
  "../../examples/access-policy.template.json",
);

interface AccessJsonShape {
  groups?: Record<string, unknown>;
}

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

function runCiMode(): number {
  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`[check-access-policy] template not found: ${TEMPLATE_PATH}`);
    return 2;
  }
  let template: Record<string, unknown>;
  try {
    template = readJson(TEMPLATE_PATH) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[check-access-policy] failed to parse template: ${(err as Error).message}`,
    );
    return 2;
  }

  // Drop top-level metadata keys (those starting with `_`, except the reserved
  // primary marker). They are documentation, not channel entries.
  const templateKeys = Object.keys(template).filter(
    (k) => !k.startsWith("_") || k === "_claudeHubExitPrimary",
  );
  const channelMapNames = [...CHANNEL_MAP.keys()];

  const result = checkAccessPolicyTemplate(channelMapNames, templateKeys);

  console.log("[check-access-policy] mode: --ci (template comparison)");
  console.log(`  CHANNEL_MAP names:  ${channelMapNames.length}`);
  console.log(
    `  template entries:   ${templateKeys.length} (incl. _claudeHubExitPrimary)`,
  );

  if (result.inSync) {
    console.log("  status:             ✓ in sync");
    return 0;
  }

  console.error("  status:             ✗ mismatch");
  if (result.missingFromTemplate.length > 0) {
    console.error("");
    console.error(
      "  Missing from examples/access-policy.template.json (add these):",
    );
    for (const name of result.missingFromTemplate) {
      console.error(`    - ${name}`);
    }
  }
  if (result.extraInTemplate.length > 0) {
    console.error("");
    console.error(
      "  Stale entries in examples/access-policy.template.json (remove these):",
    );
    for (const name of result.extraInTemplate) {
      console.error(`    - ${name}`);
    }
  }
  console.error("");
  console.error(
    "  Reminder: also update your local ~/.claude/channels/discord/access.json",
  );
  console.error("  with the real Discord channel IDs for any newly added channels.");
  return 1;
}

function runLocalMode(): number {
  if (!existsSync(ACCESS_JSON_PATH)) {
    console.error(
      `[check-access-policy] access.json not found at ${ACCESS_JSON_PATH}`,
    );
    console.error(
      "  This is a local-only check; if you don't run the supervisor on this",
    );
    console.error(
      "  machine, you can ignore this and rely on the --ci template check.",
    );
    return 2;
  }
  let parsed: AccessJsonShape;
  try {
    parsed = readJson(ACCESS_JSON_PATH) as AccessJsonShape;
  } catch (err) {
    console.error(
      `[check-access-policy] failed to parse access.json: ${(err as Error).message}`,
    );
    return 2;
  }

  const groups = parsed.groups ?? {};
  const groupCount = Object.keys(groups).length;
  const channelMapNames = [...CHANNEL_MAP.keys()];

  const result = checkAccessPolicyCounts(channelMapNames.length, groupCount);

  console.log("[check-access-policy] mode: local (access.json count check)");
  console.log(`  CHANNEL_MAP entries:    ${channelMapNames.length}`);
  console.log(`  access.json groups:     ${result.actual}`);
  console.log(
    `  expected groups count:  ${result.expected} (CHANNEL_MAP + claudeHubExit primary)`,
  );

  if (result.inSync) {
    console.log("  status:                 ✓ counts match");
    return 0;
  }

  console.error(
    `  status:                 ✗ off by ${Math.abs(result.diff)} (${
      result.diff > 0 ? "extra" : "missing"
    })`,
  );
  console.error("");
  if (result.diff < 0) {
    console.error(
      `  ${Math.abs(result.diff)} channel(s) likely missing from access.json.`,
    );
    console.error("  CHANNEL_MAP names (verify each has a group entry):");
    for (const name of channelMapNames) {
      console.error(`    - ${name}`);
    }
    console.error("");
    console.error(`  Edit:  ${ACCESS_JSON_PATH}`);
  } else {
    console.error(
      `  access.json has ${result.diff} extra group(s) not represented in CHANNEL_MAP.`,
    );
    console.error(
      "  This may be intentional (e.g., legacy / test channels) but verify.",
    );
  }
  return 1;
}

function main(): number {
  const mode = process.argv.includes("--ci") ? "ci" : "local";
  return mode === "ci" ? runCiMode() : runLocalMode();
}

process.exit(main());
