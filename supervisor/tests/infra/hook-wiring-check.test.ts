// supervisor/tests/infra/hook-wiring-check.test.ts (Issue #370 A-2)
//
// Journey-AC #5: removing ask-user-relay.sh from settings must surface a
// warning at supervisor startup instead of silently regressing to the
// "hook exists but is unreachable" state that hid Issue #370 for months.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import {
  findMissingHookWiring,
  findHookTimeoutShortfalls,
  formatHookWiringAlert,
  checkHookWiring,
  REQUIRED_SUPERVISOR_HOOKS,
  ASK_HOOK_MIN_TIMEOUT_SEC,
  ASK_HOOK_RECOMMENDED_TIMEOUT_SEC,
} from "../../src/infra/hook-wiring-check";
import {
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
} from "../../src/session/relay-server";

/** Settings fixture with every required supervisor hook wired. */
function fullyWiredSettings(): unknown {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command:
                "bash /Users/x/claude-hub/supervisor/hooks/progress-relay.sh",
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command:
                "bash /Users/x/claude-hub/supervisor/hooks/stop-relay.sh",
            },
            { type: "command", command: "bash ~/.claude/hooks/other.sh" },
          ],
        },
      ],
      PermissionRequest: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command:
                "bash /Users/x/claude-hub/supervisor/hooks/auto-approve-permission.sh",
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "bash ~/.claude/hooks/block-dangerous.sh" },
          ],
        },
        {
          matcher: "AskUserQuestion",
          hooks: [
            {
              type: "command",
              command:
                "bash /Users/x/claude-hub/supervisor/hooks/ask-user-relay.sh",
              // Issue #416: this fixture used to say 320 — the value shipped in
              // the real settings.json, which caps a 5-hour wait at 5m20s. It is
              // now the compliant value so "fully wired" means "actually works".
              timeout: ASK_HOOK_RECOMMENDED_TIMEOUT_SEC,
            },
          ],
        },
      ],
    },
  };
}

describe("findMissingHookWiring", () => {
  test("fully wired settings: no missing hooks", () => {
    expect(findMissingHookWiring(fullyWiredSettings())).toEqual([]);
  });

  test("ask-user-relay missing from PreToolUse is reported (Issue #370 D1)", () => {
    const settings = fullyWiredSettings() as {
      hooks: { PreToolUse: { matcher: string }[] };
    };
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      (g) => g.matcher !== "AskUserQuestion"
    );

    const missing = findMissingHookWiring(settings);
    expect(missing.map((m) => m.scriptSuffix)).toEqual([
      "supervisor/hooks/ask-user-relay.sh",
    ]);
  });

  test("hook registered under the WRONG event still counts as missing", () => {
    const settings = fullyWiredSettings() as {
      hooks: Record<string, unknown[]>;
    };
    // Move ask-user-relay from PreToolUse to PostToolUse.
    const postToolUse = settings.hooks.PostToolUse ?? [];
    settings.hooks.PostToolUse = postToolUse;
    postToolUse.push({
      matcher: "AskUserQuestion",
      hooks: [
        {
          type: "command",
          command: "bash /Users/x/claude-hub/supervisor/hooks/ask-user-relay.sh",
        },
      ],
    });
    settings.hooks.PreToolUse = (
      settings.hooks.PreToolUse as { matcher: string }[]
    ).filter((g) => g.matcher !== "AskUserQuestion");

    const missing = findMissingHookWiring(settings);
    expect(missing.map((m) => m.scriptSuffix)).toEqual([
      "supervisor/hooks/ask-user-relay.sh",
    ]);
  });

  test("empty / malformed settings report every required hook", () => {
    expect(findMissingHookWiring({}).length).toBe(
      REQUIRED_SUPERVISOR_HOOKS.length
    );
    expect(findMissingHookWiring(null).length).toBe(
      REQUIRED_SUPERVISOR_HOOKS.length
    );
    expect(
      findMissingHookWiring({ hooks: { PreToolUse: "not-an-array" } }).length
    ).toBe(REQUIRED_SUPERVISOR_HOOKS.length);
  });
});

/**
 * Issue #416. The ask wait is the minimum of four layers and only three of them
 * live in this repository; the fourth is Claude Code's per-hook `timeout` in the
 * user's settings.json. Raising the three we own while the fourth stays at 320s
 * produces a 5-hour wait on paper and a 5m20s wait in reality, with no error
 * anywhere — the same class of silent cap that made the 300s default behave like
 * 13 seconds. This check makes that gap say something at startup.
 */
describe("findHookTimeoutShortfalls (Issue #416)", () => {
  /** Fixture with the ask hook's `timeout` set to `sec` (or removed if null). */
  function withAskTimeout(sec: number | null): unknown {
    const settings = fullyWiredSettings() as {
      hooks: { PreToolUse: { matcher: string; hooks: Record<string, unknown>[] }[] };
    };
    const entry = settings.hooks.PreToolUse.find(
      (g) => g.matcher === "AskUserQuestion"
    )!.hooks[0]!;
    if (sec === null) delete entry.timeout;
    else entry.timeout = sec;
    return settings;
  }

  test("the requirement tracks the server default, not a third copy of it", () => {
    // If DEFAULT_ASK_TIMEOUT_MS moves and this doesn't, the check silently stops
    // protecting the new value — which is the exact drift #416 is about.
    expect(ASK_HOOK_MIN_TIMEOUT_SEC * 1000).toBeGreaterThanOrEqual(
      DEFAULT_ASK_TIMEOUT_MS
    );
    // The recommended value covers any ASK_TIMEOUT_MS the server would accept,
    // so the user never has to come back and raise it again — and strictly
    // exceeds it, so Claude Code does not kill the hook in the same instant
    // curl is giving up (a tie there discards an answer that already arrived).
    expect(ASK_HOOK_RECOMMENDED_TIMEOUT_SEC * 1000).toBeGreaterThan(
      MAX_ASK_TIMEOUT_MS
    );
  });

  test("the value shipped before #416 (320s) is reported as a shortfall", () => {
    const shortfalls = findHookTimeoutShortfalls(withAskTimeout(320));
    expect(shortfalls.length).toBe(1);
    expect(shortfalls[0]!.hook.scriptSuffix).toBe(
      "supervisor/hooks/ask-user-relay.sh"
    );
    expect(shortfalls[0]!.effectiveSec).toBe(320);
    expect(shortfalls[0]!.implicit).toBe(false);
  });

  test("omitting timeout is a shortfall too — the default is 600s, not unlimited", () => {
    const shortfalls = findHookTimeoutShortfalls(withAskTimeout(null));
    expect(shortfalls.length).toBe(1);
    expect(shortfalls[0]!.effectiveSec).toBe(600);
    expect(shortfalls[0]!.implicit).toBe(true);
  });

  test("a sufficient timeout reports nothing", () => {
    expect(
      findHookTimeoutShortfalls(withAskTimeout(ASK_HOOK_MIN_TIMEOUT_SEC))
    ).toEqual([]);
    expect(
      findHookTimeoutShortfalls(withAskTimeout(ASK_HOOK_RECOMMENDED_TIMEOUT_SEC))
    ).toEqual([]);
  });

  test("an unwired hook is not double-reported as a timeout shortfall", () => {
    // findMissingHookWiring already covers it; two warnings for one cause would
    // just make the real one harder to spot.
    const settings = fullyWiredSettings() as {
      hooks: { PreToolUse: { matcher: string }[] };
    };
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      (g) => g.matcher !== "AskUserQuestion"
    );
    expect(findMissingHookWiring(settings).length).toBe(1);
    expect(findHookTimeoutShortfalls(settings)).toEqual([]);
  });

  test("hooks with no wait requirement are never flagged, however short", () => {
    // Only ask-user-relay declares minTimeoutSec; the others return promptly.
    expect(
      REQUIRED_SUPERVISOR_HOOKS.filter((h) => h.minTimeoutSec !== undefined).map(
        (h) => h.scriptSuffix
      )
    ).toEqual(["supervisor/hooks/ask-user-relay.sh"]);
    // stop-relay.sh has no `timeout` at all in the fixture and stays silent.
    expect(findHookTimeoutShortfalls(fullyWiredSettings())).toEqual([]);
  });
});

describe("checkHookWiring (file wrapper)", () => {
  test("returns warnings for missing wiring and never throws on a real file", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "hook-wiring-test-"));
    try {
      const path = resolve(dir, "settings.json");
      writeFileSync(path, JSON.stringify({ hooks: {} }), "utf8");
      const warnings = checkHookWiring(path);
      expect(warnings.length).toBe(REQUIRED_SUPERVISOR_HOOKS.length);
      expect(warnings[0]).toContain("未配線");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable settings file degrades to a single skip warning (fail-soft)", () => {
    const warnings = checkHookWiring("/nonexistent/settings.json");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("スキップ");
  });

  test("fully wired file returns no warnings", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "hook-wiring-test-"));
    try {
      const path = resolve(dir, "settings.json");
      writeFileSync(path, JSON.stringify(fullyWiredSettings()), "utf8");
      expect(checkHookWiring(path)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wired-but-too-short ask hook warns with the value to set (Issue #416)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "hook-wiring-test-"));
    try {
      const path = resolve(dir, "settings.json");
      const settings = fullyWiredSettings() as {
        hooks: { PreToolUse: { matcher: string; hooks: { timeout: number }[] }[] };
      };
      settings.hooks.PreToolUse.find(
        (g) => g.matcher === "AskUserQuestion"
      )!.hooks[0]!.timeout = 320;
      writeFileSync(path, JSON.stringify(settings), "utf8");

      const warnings = checkHookWiring(path);
      expect(warnings.length).toBe(1);
      // Actionable: names the file, the current value, and the value to set.
      expect(warnings[0]).toContain("ask-user-relay.sh");
      expect(warnings[0]).toContain("320 秒");
      expect(warnings[0]).toContain(`"timeout": ${ASK_HOOK_RECOMMENDED_TIMEOUT_SEC}`);
      // Says why raising the supervisor alone won't help — the point of #416.
      expect(warnings[0]).toContain("supervisor 側を伸ばしても効きません");
      expect(warnings[0]).not.toContain("未配線");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * PR #431 review, should-5. A warning that only reaches `console.error` is a
 * warning nobody acts on — supervisor.stderr.log is ~1.4MB and dominated by a
 * per-30s ResourceMonitor line. These warnings are only useful if a human edits
 * settings.json, so the escalation message is a pure function that bot.ts posts
 * to the hijoguchi channel.
 */
describe("formatHookWiringAlert (Issue #416 / #431 should-5)", () => {
  test("renders every warning as a bullet and says why it keeps repeating", () => {
    const alert = formatHookWiringAlert(["[HookWiring] A", "[HookWiring] B"]);
    expect(alert).toContain("- [HookWiring] A");
    expect(alert).toContain("- [HookWiring] B");
    // The operator has to know this is on them to fix, not a transient blip.
    expect(alert).toContain("settings.json");
    expect(alert).toContain("起動のたびに");
  });

  test("returns null for no warnings so a healthy startup never posts", () => {
    expect(formatHookWiringAlert([])).toBeNull();
  });
});
