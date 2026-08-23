import { describe, test, expect } from "bun:test";
import {
  BRIEF_DEDUP_WINDOW_MS,
  BRIEF_DISABLED_ENV,
  BRIEF_PREFIX,
  evaluateBriefTrigger,
  isBriefCommand,
  isBriefDisabled,
  parseBriefCommand,
  type BriefTriggerInput,
} from "../../src/session/corp-brief";
import type { AccessPolicy } from "../../src/config/access-policy";

/**
 * Issue #426 → #449: corp posts `/brief <YYYY-MM-DD>` to a known channel and
 * the supervisor fetches the day's pending proposals and posts tap-to-decide
 * buttons directly in the channel (corp#112 AC-1, session-less).
 *
 * This path triggers CLI execution in the channel's working directory, so the
 * tests below fix the two properties that keep it from becoming an
 * approval-gate bypass:
 *
 *   1. **fail-closed authorization** — the same `dispatchFrom` gate as
 *      `/dispatch`, denying on missing policy / unconfigured channel / empty
 *      list / unlisted source;
 *   2. **no free text** — the only external input is a `YYYY-MM-DD` token; what
 *      gets executed is fixed argv from CHANNEL_MAP, so extra tokens are
 *      rejected rather than interpreted.
 */

const CHANNEL_ID = "111111111111111111";
const CORP_BOT_ID = "222222222222222222";
const OTHER_ID = "333333333333333333";

/** Policy that authorizes CORP_BOT_ID on CHANNEL_ID (the intended setup). */
function allowingPolicy(): AccessPolicy {
  return {
    groups: {
      [CHANNEL_ID]: {
        requireMention: false,
        allowFrom: [],
        dispatchFrom: [CORP_BOT_ID],
      },
    },
  };
}

/**
 * Base input for the evaluator. `env` / `envAllowedSourceIds` are always passed
 * explicitly so a stray `CORP_BRIEF_DISABLED` / `DISPATCH_ALLOWED_SOURCE_IDS`
 * in the developer's shell cannot change the verdict under test.
 */
function input(over: Partial<BriefTriggerInput> = {}): BriefTriggerInput {
  return {
    content: `${BRIEF_PREFIX} 2026-08-13`,
    channelId: CHANNEL_ID,
    sourceId: CORP_BOT_ID,
    policy: allowingPolicy(),
    env: {},
    envAllowedSourceIds: [],
    ...over,
  };
}

describe("isBriefCommand / parseBriefCommand", () => {
  test("recognises the exact trigger token", () => {
    expect(isBriefCommand("/brief 2026-08-13")).toBe(true);
    expect(isBriefCommand("  /brief 2026-08-13  ")).toBe(true);
    expect(isBriefCommand("/brief")).toBe(true);
  });

  test("does not match a different command with the same prefix", () => {
    // `/briefing` must not be mistaken for `/brief` (token boundary).
    expect(isBriefCommand("/briefing 2026-08-13")).toBe(false);
    expect(isBriefCommand("/dispatch corp-dispatch-42 42")).toBe(false);
    expect(isBriefCommand("朝レポです")).toBe(false);
  });

  test("parses a valid date", () => {
    const r = parseBriefCommand("/brief 2026-08-13");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.date).toBe("2026-08-13");
  });

  test("accepts a real leap day", () => {
    const r = parseBriefCommand("/brief 2024-02-29");
    expect(r.kind).toBe("ok");
  });

  test("returns not_brief for an unrelated message", () => {
    expect(parseBriefCommand("こんにちは").kind).toBe("not_brief");
  });

  test("rejects a missing date", () => {
    const r = parseBriefCommand("/brief");
    expect(r.kind).toBe("error");
  });

  test("rejects extra tokens (no free text may ride along)", () => {
    // The whole point of the closed token: anything beyond the date is refused,
    // never silently dropped and never interpreted.
    const r = parseBriefCommand("/brief 2026-08-13 rm -rf ~");
    expect(r.kind).toBe("error");
  });

  test("rejects extra content on a following line (LF / CRLF / CR)", () => {
    // A multi-line body is the most ordinary shape for a bot post, so this is
    // the likeliest way free text would try to ride along. It is refused today
    // because the split is `/\s+/` (newlines are whitespace) — pin it, so a
    // future line-oriented rewrite ("look at the first line only", `split(" ")`)
    // fails here instead of quietly accepting the rest.
    for (const sep of ["\n", "\r\n", "\r"]) {
      const r = parseBriefCommand(`/brief 2026-08-13${sep}rm -rf ~`);
      expect(r.kind).toBe("error");
    }
  });

  test("rejects control characters riding on the date token", () => {
    // NUL / ESC / RTL-override attached to an otherwise valid date. None of
    // these are whitespace, so they stay part of the token and the anchored
    // date regex refuses them rather than trimming them off. Written as \u
    // escapes on purpose — an invisible byte in a test file is unreviewable.
    for (const bad of [
      "/brief 2026-08-13\u0000",
      "/brief 2026-08-13\u001b[31m",
      "/brief \u202e2026-08-13",
    ]) {
      expect(parseBriefCommand(bad).kind).toBe("error");
    }
  });

  test("rejects a malformed date", () => {
    for (const bad of [
      "/brief 2026/08/13",
      "/brief 26-08-13",
      "/brief 2026-8-13",
      "/brief today",
      "/brief 2026-08-13T00:00",
    ]) {
      expect(parseBriefCommand(bad).kind).toBe("error");
    }
  });

  test("rejects a well-formed but non-existent date", () => {
    for (const bad of ["/brief 2026-02-30", "/brief 2026-13-01", "/brief 2026-00-10"]) {
      expect(parseBriefCommand(bad).kind).toBe("error");
    }
  });
});

describe("isBriefDisabled (kill-switch)", () => {
  test("off by default", () => {
    expect(isBriefDisabled({})).toBe(false);
    expect(isBriefDisabled({ [BRIEF_DISABLED_ENV]: "" })).toBe(false);
    expect(isBriefDisabled({ [BRIEF_DISABLED_ENV]: "0" })).toBe(false);
  });

  test("any other value disables (stopping is the safe direction)", () => {
    expect(isBriefDisabled({ [BRIEF_DISABLED_ENV]: "1" })).toBe(true);
    expect(isBriefDisabled({ [BRIEF_DISABLED_ENV]: "true" })).toBe(true);
  });
});

describe("evaluateBriefTrigger — authorization is fail-closed", () => {
  test("denies when the policy is unavailable (missing / unparsable file)", () => {
    const d = evaluateBriefTrigger(input({ policy: null }));
    expect(d.action).toBe("denied");
    if (d.action === "denied") expect(d.reason).toBe("policy_unavailable");
  });

  test("denies when the channel is not configured in groups", () => {
    const d = evaluateBriefTrigger(input({ policy: { groups: {} } }));
    expect(d.action).toBe("denied");
    if (d.action === "denied") expect(d.reason).toBe("channel_not_configured");
  });

  test("denies when dispatchFrom is empty (empty is NOT 'any source')", () => {
    const policy: AccessPolicy = {
      groups: { [CHANNEL_ID]: { requireMention: false, allowFrom: [], dispatchFrom: [] } },
    };
    const d = evaluateBriefTrigger(input({ policy }));
    expect(d.action).toBe("denied");
    if (d.action === "denied") expect(d.reason).toBe("source_not_allowlisted");
  });

  test("denies when dispatchFrom is absent entirely", () => {
    const policy: AccessPolicy = {
      groups: { [CHANNEL_ID]: { requireMention: false, allowFrom: [CORP_BOT_ID] } },
    };
    const d = evaluateBriefTrigger(input({ policy }));
    expect(d.action).toBe("denied");
    if (d.action === "denied") expect(d.reason).toBe("source_not_allowlisted");
  });

  test("denies a sender that is not the allowlisted source", () => {
    const d = evaluateBriefTrigger(input({ sourceId: OTHER_ID }));
    expect(d.action).toBe("denied");
    if (d.action === "denied") expect(d.reason).toBe("source_not_allowlisted");
  });

  test("denies before parsing — a malformed command from an unlisted source is 'denied', not 'rejected'", () => {
    // Order matters: an unauthorized source's input must not be interpreted at
    // all (same order as handleDispatchMessage).
    const d = evaluateBriefTrigger(
      input({ sourceId: OTHER_ID, content: "/brief まったくの自由文" }),
    );
    expect(d.action).toBe("denied");
  });

  test("a denied source never reaches decide", () => {
    const d = evaluateBriefTrigger(input({ policy: null }));
    expect(d.action).not.toBe("decide");
  });

  test("allows the source listed in the env allowlist (shared with /dispatch)", () => {
    const d = evaluateBriefTrigger(
      input({ sourceId: OTHER_ID, envAllowedSourceIds: [OTHER_ID] }),
    );
    expect(d.action).toBe("decide");
  });

  test("the env allowlist does not bypass the 'channel must be configured' gate", () => {
    const d = evaluateBriefTrigger(
      input({ policy: { groups: {} }, envAllowedSourceIds: [CORP_BOT_ID] }),
    );
    expect(d.action).toBe("denied");
    if (d.action === "denied") expect(d.reason).toBe("channel_not_configured");
  });
});

describe("evaluateBriefTrigger — trigger handling", () => {
  test("ignores a message that is not a /brief", () => {
    expect(evaluateBriefTrigger(input({ content: "おはようございます" })).action).toBe(
      "ignore",
    );
  });

  test("kill-switch stops an otherwise valid trigger", () => {
    const d = evaluateBriefTrigger(input({ env: { [BRIEF_DISABLED_ENV]: "1" } }));
    expect(d.action).toBe("disabled");
  });

  test("rejects a malformed command from an authorized source", () => {
    const d = evaluateBriefTrigger(input({ content: "/brief 2026-02-30" }));
    expect(d.action).toBe("rejected");
    if (d.action === "rejected") expect(d.reason.length).toBeGreaterThan(0);
  });

  test("an authorized, well-formed trigger resolves to decide (#449: no session involved)", () => {
    const d = evaluateBriefTrigger(input());
    expect(d.action).toBe("decide");
    if (d.action === "decide") expect(d.date).toBe("2026-08-13");
  });

  test("the decision carries no caller-supplied text", () => {
    // A rejected command cannot contribute text, and an accepted one only ever
    // contributes the date — so nothing from the wire can appear verbatim.
    const marker = "IGNORE-PREVIOUS-INSTRUCTIONS";
    const d = evaluateBriefTrigger(input({ content: `/brief 2026-08-13 ${marker}` }));
    expect(d.action).toBe("rejected");
    expect(JSON.stringify(d)).not.toContain(marker);
  });
});

/**
 * PR #432 review, should-1（#449 でも維持）. corp retrying a failed delivery
 * (or a manual re-post) must not repost the same day's decision buttons twice.
 */
describe("evaluateBriefTrigger — same-day idempotency", () => {
  const NOW = 1_760_000_000_000;

  test("a repeat of the same date inside the window is a duplicate", () => {
    const d = evaluateBriefTrigger(
      input({
        nowMs: NOW,
        recentBrief: { date: "2026-08-13", atMs: NOW - 60_000 },
      }),
    );
    expect(d.action).toBe("duplicate");
    if (d.action === "duplicate") expect(d.elapsedMs).toBe(60_000);
  });

  test("a repeat AFTER the window is allowed (a deliberate re-trigger stays possible)", () => {
    const d = evaluateBriefTrigger(
      input({
        nowMs: NOW,
        recentBrief: { date: "2026-08-13", atMs: NOW - BRIEF_DEDUP_WINDOW_MS - 1 },
      }),
    );
    expect(d.action).toBe("decide");
  });

  test("a different date is never a duplicate", () => {
    const d = evaluateBriefTrigger(
      input({
        content: "/brief 2026-08-14",
        nowMs: NOW,
        recentBrief: { date: "2026-08-13", atMs: NOW - 60_000 },
      }),
    );
    expect(d.action).toBe("decide");
  });

  test("no record means the retry is evaluated normally (failed posts stay recoverable)", () => {
    // The caller records only after the decision message was posted, so a brief
    // that failed at the CLI / post stage leaves no record — this pins the
    // evaluator side of that contract.
    const d = evaluateBriefTrigger(input({ nowMs: NOW, recentBrief: undefined }));
    expect(d.action).toBe("decide");
  });
});
