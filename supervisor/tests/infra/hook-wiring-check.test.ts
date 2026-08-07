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
  checkHookWiring,
  REQUIRED_SUPERVISOR_HOOKS,
} from "../../src/infra/hook-wiring-check";

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
              timeout: 320,
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
});
