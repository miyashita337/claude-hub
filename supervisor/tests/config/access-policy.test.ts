import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isSenderAllowed,
  loadAccessPolicy,
  evaluateAccess,
  isDispatchSourceAllowed,
} from "../../src/config/access-policy";

/**
 * Issue #32 / S7: runtime enforcement of access.json `allowFrom` /
 * `requireMention` before relaying any Discord message into a Claude session.
 *
 * The semantics mirror the upstream discord plugin's `gate()` group path
 * (external_plugins/discord/server.ts):
 *   - undefined channel policy            -> DENY (fail-closed)
 *   - groupAllowFrom non-empty + sender not in it -> DENY
 *   - requireMention true + not mentioned -> DENY
 *   - otherwise                           -> ALLOW
 *
 * The fail-closed default (missing / broken file, undefined channel) is the
 * Critical security property: relay only happens for an explicitly allowed
 * sender on an explicitly defined channel.
 */

const OWNER = "184695080709324800";
const OUTSIDER = "999999999999999999";
const CHANNEL = "846209781206941736";

describe("isSenderAllowed (pure)", () => {
  test("allows an allowlisted sender that mentions the bot", () => {
    const policy = {
      groups: {
        [CHANNEL]: { requireMention: true, allowFrom: [OWNER] },
      },
    };
    const r = isSenderAllowed(policy, CHANNEL, OWNER, true);
    expect(r.allowed).toBe(true);
  });

  test("rejects a non-allowlisted sender even when mentioning the bot", () => {
    const policy = {
      groups: {
        [CHANNEL]: { requireMention: true, allowFrom: [OWNER] },
      },
    };
    const r = isSenderAllowed(policy, CHANNEL, OUTSIDER, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("sender_not_allowlisted");
  });

  test("rejects an allowlisted sender when requireMention is set but no mention", () => {
    const policy = {
      groups: {
        [CHANNEL]: { requireMention: true, allowFrom: [OWNER] },
      },
    };
    const r = isSenderAllowed(policy, CHANNEL, OWNER, false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("mention_required");
  });

  test("DENY (fail-closed) when the channel is not defined in groups", () => {
    const policy = {
      groups: {
        [CHANNEL]: { requireMention: true, allowFrom: [OWNER] },
      },
    };
    const r = isSenderAllowed(policy, "111111111111111111", OWNER, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("channel_not_configured");
  });

  test("DENY (fail-closed) when the policy itself is null/undefined", () => {
    const r = isSenderAllowed(null, CHANNEL, OWNER, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("policy_unavailable");
  });

  test("empty groupAllowFrom means any member (still subject to requireMention)", () => {
    // Mirrors upstream: empty allowFrom = unrestricted senders for that channel.
    // This preserves the claudeHubExit primary entry semantics.
    const policy = {
      groups: {
        [CHANNEL]: { requireMention: false, allowFrom: [] },
      },
    };
    expect(isSenderAllowed(policy, CHANNEL, OUTSIDER, false).allowed).toBe(true);
    expect(isSenderAllowed(policy, CHANNEL, OWNER, false).allowed).toBe(true);
  });

  test("empty groupAllowFrom with requireMention true still requires a mention", () => {
    const policy = {
      groups: {
        [CHANNEL]: { requireMention: true, allowFrom: [] },
      },
    };
    expect(isSenderAllowed(policy, CHANNEL, OWNER, false).allowed).toBe(false);
    expect(isSenderAllowed(policy, CHANNEL, OWNER, true).allowed).toBe(true);
  });

  test("requireMention defaults to true when omitted (fail-closed default)", () => {
    const policy = {
      groups: {
        // requireMention intentionally omitted
        [CHANNEL]: { allowFrom: [OWNER] } as { allowFrom: string[] },
      },
    };
    expect(isSenderAllowed(policy, CHANNEL, OWNER, false).allowed).toBe(false);
    expect(isSenderAllowed(policy, CHANNEL, OWNER, true).allowed).toBe(true);
  });

  test("channels are independent: an allowlist on one does not leak to another", () => {
    const chA = "111111111111111111";
    const chB = "222222222222222222";
    const policy = {
      groups: {
        [chA]: { requireMention: false, allowFrom: [OWNER] },
        [chB]: { requireMention: false, allowFrom: [OUTSIDER] },
      },
    };
    // OWNER allowed in A, denied in B; OUTSIDER vice-versa.
    expect(isSenderAllowed(policy, chA, OWNER, false).allowed).toBe(true);
    expect(isSenderAllowed(policy, chA, OUTSIDER, false).allowed).toBe(false);
    expect(isSenderAllowed(policy, chB, OUTSIDER, false).allowed).toBe(true);
    expect(isSenderAllowed(policy, chB, OWNER, false).allowed).toBe(false);
  });

  test("DENY when groups object is missing entirely (malformed policy)", () => {
    const r = isSenderAllowed({} as never, CHANNEL, OWNER, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("channel_not_configured");
  });
});

describe("loadAccessPolicy", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "access-policy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loads a well-formed access.json", () => {
    const p = join(dir, "access.json");
    writeFileSync(
      p,
      JSON.stringify({
        groups: { [CHANNEL]: { requireMention: true, allowFrom: [OWNER] } },
      }),
    );
    const policy = loadAccessPolicy(p);
    expect(policy).not.toBeNull();
    expect(policy?.groups?.[CHANNEL]?.allowFrom).toEqual([OWNER]);
  });

  test("returns null when the file is missing (fail-closed signal)", () => {
    const policy = loadAccessPolicy(join(dir, "does-not-exist.json"));
    expect(policy).toBeNull();
  });

  test("returns null when the file is broken JSON (fail-closed signal)", () => {
    const p = join(dir, "access.json");
    writeFileSync(p, "{ this is not valid json ");
    const policy = loadAccessPolicy(p);
    expect(policy).toBeNull();
  });

  test("returns null when the JSON is not an object", () => {
    const p = join(dir, "access.json");
    writeFileSync(p, "[]");
    const policy = loadAccessPolicy(p);
    expect(policy).toBeNull();
  });
});

describe("evaluateAccess (load + decide, fail-closed)", () => {
  let dir: string;
  let p: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "access-eval-"));
    p = join(dir, "access.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("allows an allowlisted, mentioning sender", () => {
    writeFileSync(
      p,
      JSON.stringify({
        groups: { [CHANNEL]: { requireMention: true, allowFrom: [OWNER] } },
      }),
    );
    const r = evaluateAccess(
      { channelKey: CHANNEL, userId: OWNER, isMention: true },
      p,
    );
    expect(r.allowed).toBe(true);
  });

  test("DENY (fail-closed) when access.json is absent", () => {
    const r = evaluateAccess(
      { channelKey: CHANNEL, userId: OWNER, isMention: true },
      join(dir, "missing.json"),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("policy_unavailable");
  });

  test("DENY (fail-closed) for an undefined channel", () => {
    writeFileSync(
      p,
      JSON.stringify({
        groups: { [CHANNEL]: { requireMention: true, allowFrom: [OWNER] } },
      }),
    );
    const r = evaluateAccess(
      { channelKey: "000000000000000000", userId: OWNER, isMention: true },
      p,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("channel_not_configured");
  });

  test("reason string never contains the raw user/channel id (no secret leak)", () => {
    writeFileSync(
      p,
      JSON.stringify({
        groups: { [CHANNEL]: { requireMention: true, allowFrom: [OWNER] } },
      }),
    );
    const r = evaluateAccess(
      { channelKey: CHANNEL, userId: OUTSIDER, isMention: true },
      p,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).not.toContain(OUTSIDER);
    expect(r.reason).not.toContain(CHANNEL);
  });
});

/**
 * Issue #32 / S7 (dispatch transport): a generic external source (a Discord
 * webhook / bot, identified by its snowflake) may trigger a session via a
 * `/dispatch` message. This is the ONLY exception to the blanket
 * `message.author.bot` drop, and it is fail-closed: the source must be
 * explicitly listed in the channel's `dispatchFrom` (or the global
 * `DISPATCH_ALLOWED_SOURCE_IDS` env list), and the channel must be configured.
 */
const SOURCE = "555555555555555555";
const OTHER_SOURCE = "777777777777777777";

describe("isDispatchSourceAllowed (pure, fail-closed)", () => {
  test("allows a source listed in the channel's dispatchFrom", () => {
    const policy = {
      groups: {
        [CHANNEL]: { dispatchFrom: [SOURCE] },
      },
    };
    const r = isDispatchSourceAllowed(policy, CHANNEL, SOURCE);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("allowed");
  });

  test("rejects a source not in dispatchFrom (fail-closed)", () => {
    const policy = {
      groups: {
        [CHANNEL]: { dispatchFrom: [SOURCE] },
      },
    };
    const r = isDispatchSourceAllowed(policy, CHANNEL, OTHER_SOURCE);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("source_not_allowlisted");
  });

  test("DENY when the channel has no dispatchFrom at all (fail-closed)", () => {
    const policy = {
      groups: {
        [CHANNEL]: { requireMention: true, allowFrom: [OWNER] },
      },
    };
    const r = isDispatchSourceAllowed(policy, CHANNEL, SOURCE);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("source_not_allowlisted");
  });

  test("DENY (fail-closed) when the channel is not configured", () => {
    const policy = {
      groups: {
        [CHANNEL]: { dispatchFrom: [SOURCE] },
      },
    };
    const r = isDispatchSourceAllowed(policy, "000000000000000000", SOURCE);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("channel_not_configured");
  });

  test("DENY (fail-closed) when policy is null/undefined", () => {
    const r = isDispatchSourceAllowed(null, CHANNEL, SOURCE);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("policy_unavailable");
  });

  test("allows a source listed in the env global allowlist (channel must still be configured)", () => {
    const policy = {
      groups: {
        // Channel configured but with an empty/absent dispatchFrom.
        [CHANNEL]: { requireMention: true, allowFrom: [OWNER] },
      },
    };
    const r = isDispatchSourceAllowed(policy, CHANNEL, SOURCE, [SOURCE]);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("allowed");
  });

  test("env allowlist does NOT bypass the channel-configured requirement (fail-closed)", () => {
    const policy = {
      groups: {
        [CHANNEL]: { dispatchFrom: [SOURCE] },
      },
    };
    // Source is in env, but the channel is undefined -> still DENY.
    const r = isDispatchSourceAllowed(policy, "999000999000999000", SOURCE, [
      SOURCE,
    ]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("channel_not_configured");
  });

  test("empty dispatchFrom does NOT mean 'any source' (unlike allowFrom)", () => {
    // Critical: dispatch is privileged automation; an empty list must DENY,
    // never widen to any bot/webhook.
    const policy = {
      groups: {
        [CHANNEL]: { dispatchFrom: [] },
      },
    };
    expect(isDispatchSourceAllowed(policy, CHANNEL, SOURCE).allowed).toBe(false);
    expect(isDispatchSourceAllowed(policy, CHANNEL, SOURCE).reason).toBe(
      "source_not_allowlisted",
    );
  });

  test("reason never contains the raw source/channel id (no secret leak)", () => {
    const policy = {
      groups: { [CHANNEL]: { dispatchFrom: [SOURCE] } },
    };
    const r = isDispatchSourceAllowed(policy, CHANNEL, OTHER_SOURCE);
    expect(r.reason).not.toContain(OTHER_SOURCE);
    expect(r.reason).not.toContain(CHANNEL);
  });

  test("channels are independent for dispatch sources", () => {
    const chA = "111111111111111111";
    const chB = "222222222222222222";
    const policy = {
      groups: {
        [chA]: { dispatchFrom: [SOURCE] },
        [chB]: { dispatchFrom: [OTHER_SOURCE] },
      },
    };
    expect(isDispatchSourceAllowed(policy, chA, SOURCE).allowed).toBe(true);
    expect(isDispatchSourceAllowed(policy, chA, OTHER_SOURCE).allowed).toBe(false);
    expect(isDispatchSourceAllowed(policy, chB, OTHER_SOURCE).allowed).toBe(true);
    expect(isDispatchSourceAllowed(policy, chB, SOURCE).allowed).toBe(false);
  });
});
