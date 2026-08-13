import { describe, test, expect } from "bun:test";
import {
  BRIEF_DEDUP_WINDOW_MS,
  BRIEF_DISABLED_ENV,
  BRIEF_PREFIX,
  buildBriefInjection,
  evaluateBriefTrigger,
  isBriefCommand,
  isBriefDisabled,
  parseBriefCommand,
  selectBriefTargets,
  type BriefSessionRef,
  type BriefTriggerInput,
} from "../../src/session/corp-brief";
import type { AccessPolicy } from "../../src/config/access-policy";
import { ORCHESTRATE_BRANCH_PREFIX } from "../../src/session/orchestrate";

/**
 * Issue #426: corp posts `/brief <YYYY-MM-DD>` to a known channel and the
 * channel's already-running session is asked to put the morning brief's
 * proposals to the chairman (corp#112 AC-1).
 *
 * This path can hand instructions to the HQ session, so the tests below fix the
 * two properties that keep it from becoming an approval-gate bypass:
 *
 *   1. **fail-closed authorization** — the same `dispatchFrom` gate as
 *      `/dispatch`, denying on missing policy / unconfigured channel / empty
 *      list / unlisted source;
 *   2. **no free text** — the only external input is a `YYYY-MM-DD` token and
 *      the injected sentence is built here, so extra tokens are rejected rather
 *      than forwarded.
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

const ONE_SESSION: BriefSessionRef[] = [{ threadId: "thread-1" }];

/**
 * Base input for the evaluator. `env` / `envAllowedSourceIds` are always passed
 * explicitly so a stray `CORP_BRIEF_DISABLED` / `DISPATCH_ALLOWED_SOURCE_IDS`
 * in the developer's shell cannot change the verdict under test. `askPending`
 * defaults to "nothing outstanding" so only the tests that care set it.
 */
function input(over: Partial<BriefTriggerInput> = {}): BriefTriggerInput {
  return {
    content: `${BRIEF_PREFIX} 2026-08-13`,
    channelId: CHANNEL_ID,
    sourceId: CORP_BOT_ID,
    policy: allowingPolicy(),
    sessions: ONE_SESSION,
    askPending: () => false,
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
    // never silently dropped and never forwarded into the session.
    const r = parseBriefCommand("/brief 2026-08-13 rm -rf ~");
    expect(r.kind).toBe("error");
  });

  test("rejects extra content on a following line (LF / CRLF / CR)", () => {
    // A multi-line body is the most ordinary shape for a bot post, so this is
    // the likeliest way free text would try to ride along. It is refused today
    // because the split is `/\s+/` (newlines are whitespace) — pin it, so a
    // future line-oriented rewrite ("look at the first line only", `split(" ")`)
    // fails here instead of quietly forwarding the rest into the HQ session.
    for (const sep of ["\n", "\r\n", "\r"]) {
      const r = parseBriefCommand(`/brief 2026-08-13${sep}rm -rf ~`);
      expect(r.kind).toBe("error");
    }
  });

  test("rejects control characters riding on the date token", () => {
    // NUL / ESC / RTL-override attached to an otherwise valid date. None of
    // these are whitespace, so they stay part of the token and the anchored
    // date regex refuses them rather than trimming them off. Written as \\u
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

describe("buildBriefInjection", () => {
  test("embeds the date and asks for AskUserQuestion", () => {
    const text = buildBriefInjection("2026-08-13");
    expect(text).toContain("2026-08-13");
    expect(text).toContain("AskUserQuestion");
  });

  test("is a single line (relay flattens newlines for tmux send-keys)", () => {
    expect(buildBriefInjection("2026-08-13")).not.toContain("\n");
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
    // The live access.json has no group for #corp today, so this is the current
    // real-world state: the trigger is refused until the group is added.
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

  test("a denied source never reaches inject, even with exactly one session", () => {
    const d = evaluateBriefTrigger(input({ policy: null, sessions: ONE_SESSION }));
    expect(d.action).not.toBe("inject");
  });

  test("allows the source listed in the env allowlist (shared with /dispatch)", () => {
    const d = evaluateBriefTrigger(
      input({ sourceId: OTHER_ID, envAllowedSourceIds: [OTHER_ID] }),
    );
    expect(d.action).toBe("inject");
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

  test("injects into the single running session", () => {
    const d = evaluateBriefTrigger(input());
    expect(d.action).toBe("inject");
    if (d.action === "inject") {
      expect(d.threadId).toBe("thread-1");
      expect(d.date).toBe("2026-08-13");
      expect(d.text).toBe(buildBriefInjection("2026-08-13"));
    }
  });

  test("reports no_session when nothing is running (AC-3: never silent)", () => {
    const d = evaluateBriefTrigger(input({ sessions: [] }));
    expect(d.action).toBe("no_session");
    if (d.action === "no_session") expect(d.date).toBe("2026-08-13");
  });

  test("refuses to guess when several candidate sessions are running", () => {
    const d = evaluateBriefTrigger(
      input({ sessions: [{ threadId: "thread-1" }, { threadId: "thread-2" }] }),
    );
    expect(d.action).toBe("ambiguous");
    if (d.action === "ambiguous") expect(d.count).toBe(2);
  });
});

/**
 * PR #432 review, must-1. This is the one capability `/dispatch` and
 * `/orchestrate` do not have: they only ever type into a session they just
 * started, while `/brief` types into a session that was ALREADY running and
 * whose state it does not own. `sendToPane` leads every send with `Escape`, so
 * injecting while the chairman has an AskUserQuestion open could discard the
 * pending decision — or, if Escape picks a fallback dialog's default, answer it
 * on their behalf. That is the failure class #412 / #416 / #423 just closed.
 */
describe("evaluateBriefTrigger — never interrupts a pending decision (#432 must-1)", () => {
  test("defers instead of injecting when the target thread is awaiting an answer", () => {
    const d = evaluateBriefTrigger(input({ askPending: () => true }));
    expect(d.action).toBe("deferred");
    if (d.action === "deferred") {
      expect(d.threadId).toBe("thread-1");
      expect(d.date).toBe("2026-08-13");
    }
  });

  test("the guard is asked about the RESOLVED target thread, not any thread", () => {
    // A pending ask on some other thread must not block this channel's brief,
    // and a pending ask on the target must block it — so the predicate has to
    // receive the thread the injection would actually go to.
    const asked: string[] = [];
    const d = evaluateBriefTrigger(
      input({
        sessions: [{ threadId: "thread-target" }],
        askPending: (threadId) => {
          asked.push(threadId);
          return threadId === "someone-else";
        },
      }),
    );
    expect(asked).toEqual(["thread-target"]);
    expect(d.action).toBe("inject");
  });

  test("the ask guard runs even for an otherwise perfect trigger", () => {
    // Guards against a refactor that checks askPending only on some branch:
    // authorized, well-formed, exactly one target — and still deferred.
    const d = evaluateBriefTrigger(
      input({ policy: allowingPolicy(), askPending: () => true }),
    );
    expect(d.action).not.toBe("inject");
  });

  test("no target session means no ask question to answer (no_session wins)", () => {
    // Ordering check: with zero candidates there is no thread to ask about, so
    // the predicate must not be consulted with a bogus id.
    let called = false;
    const d = evaluateBriefTrigger(
      input({
        sessions: [],
        askPending: () => {
          called = true;
          return true;
        },
      }),
    );
    expect(d.action).toBe("no_session");
    expect(called).toBe(false);
  });
});

/**
 * PR #432 review, should-1. corp retrying a failed delivery (or a manual
 * re-post) must not interrupt the running conversation twice for the same day.
 */
describe("evaluateBriefTrigger — same-day idempotency (#432 should-1)", () => {
  const NOW = 1_760_000_000_000;

  test("a repeat of the same date inside the window is not injected again", () => {
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
    expect(d.action).toBe("inject");
  });

  test("a different date is never a duplicate", () => {
    const d = evaluateBriefTrigger(
      input({
        content: "/brief 2026-08-14",
        nowMs: NOW,
        recentBrief: { date: "2026-08-13", atMs: NOW - 60_000 },
      }),
    );
    expect(d.action).toBe("inject");
  });

  test("de-dup does not mask a deferred/no_session retry", () => {
    // The caller records only on `inject`, so a brief that ended as deferred
    // leaves no record — this pins the evaluator side of that contract: with no
    // record, the retry is evaluated normally rather than swallowed.
    const d = evaluateBriefTrigger(
      input({ nowMs: NOW, recentBrief: undefined, askPending: () => false }),
    );
    expect(d.action).toBe("inject");
  });
});

describe("selectBriefTargets — orchestrator sessions are not candidates", () => {
  test("drops orchestrator sessions, keeps the rest", () => {
    const kept = selectBriefTargets([
      { threadId: "ceo" },
      { threadId: "orc", branch: `${ORCHESTRATE_BRANCH_PREFIX}20260813-0700` },
      { threadId: "worktree", branch: "corp-brief-work" },
    ]);
    expect(kept.map((s) => s.threadId)).toEqual(["ceo", "worktree"]);
  });

  test("an orchestrator running alongside the CEO session does not block the brief", () => {
    // Regression for the failure mode CodeRabbit flagged on PR #432: without
    // the filter this pair is `ambiguous`, so the morning brief silently never
    // reaches the CEO whenever an orchestrator happens to be up.
    const d = evaluateBriefTrigger(
      input({
        sessions: [
          { threadId: "thread-1", branch: "corp" },
          {
            threadId: "thread-orc",
            branch: `${ORCHESTRATE_BRANCH_PREFIX}20260813-0700`,
          },
        ],
      }),
    );
    expect(d.action).toBe("inject");
    if (d.action === "inject") expect(d.threadId).toBe("thread-1");
  });

  test("an orchestrator alone is not a target (no CEO session to ask)", () => {
    const d = evaluateBriefTrigger(
      input({
        sessions: [
          {
            threadId: "thread-orc",
            branch: `${ORCHESTRATE_BRANCH_PREFIX}20260813-0700`,
          },
        ],
      }),
    );
    expect(d.action).toBe("no_session");
  });

  test("two non-orchestrator sessions still refuse (the filter narrows, it does not guess)", () => {
    const d = evaluateBriefTrigger(
      input({
        sessions: [
          { threadId: "thread-1", branch: "corp" },
          { threadId: "thread-2", branch: "corp-dispatch-99" },
        ],
      }),
    );
    expect(d.action).toBe("ambiguous");
  });

  test("the injected text carries no caller-supplied text", () => {
    // A rejected command cannot contribute text, and an accepted one only ever
    // contributes the date — so nothing from the wire can appear verbatim.
    const marker = "IGNORE-PREVIOUS-INSTRUCTIONS";
    const d = evaluateBriefTrigger(input({ content: `/brief 2026-08-13 ${marker}` }));
    expect(d.action).toBe("rejected");
    expect(JSON.stringify(d)).not.toContain(marker);
  });
});
