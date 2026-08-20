// supervisor/tests/hooks/ask-user-relay.test.ts (Issue #12 Phase 1 / #370)
//
// Black-box test for hooks/ask-user-relay.sh. Uses a mock curl to capture the
// outbound POST and feed back a synthetic supervisor reply, then asserts the
// hook's stdout produces the PreToolUse deny envelope that carries the user's
// answer back to Claude so it resumes without blocking on the TUI dialog.
//
// Issue #370 (D2): AskUserQuestion's real input shape is `questions[]` — an
// array of { question, header, multiSelect, options[{label, description}] }.
// The old tests fixed a flat `{ question: "..." }` shape that the tool never
// sends, which let the schema mismatch pass CI. All fixtures here use the
// real shape captured from a live transcript
// (~/.claude/projects/.../6639c00f-....jsonl, 2026-08-06T07:13:18Z).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/ask-user-relay.sh");

interface TestEnv {
  dir: string;
  runtimeDir: string;
  mockBinDir: string;
  curlArgsFile: string;
  curlStdinFile: string;
}

function setupTestEnv(opts: {
  relayUrl?: string;
  curlOutput?: string;
  curlExit?: number;
}): TestEnv {
  const dir = mkdtempSync(resolve(tmpdir(), "ask-user-relay-test-"));
  const runtimeDir = mkdtempSync(resolve(tmpdir(), "ask-user-relay-runtime-"));

  if (opts.relayUrl !== undefined) {
    const sanitisedCwd = dir.replace(/^\/+/, "").replace(/\//g, "_");
    const relayDir = resolve(runtimeDir, "claude-hub-supervisor");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      resolve(relayDir, `${sanitisedCwd}.relay-url`),
      opts.relayUrl,
      "utf8",
    );
  }

  const mockBinDir = resolve(dir, "mock-bin");
  mkdirSync(mockBinDir, { recursive: true });

  const curlArgsFile = resolve(dir, "curl-args.txt");
  const curlStdinFile = resolve(dir, "curl-stdin.json");
  // Mock curl: captures args + stdin (when -d @- is used) and returns the
  // configured payload to stdout. Default exit code is 0.
  const curlExit = opts.curlExit ?? 0;
  const curlOutput = opts.curlOutput ?? "";
  const escapedOutput = curlOutput
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$");
  const mockCurl = `#!/bin/bash
echo "$@" > "${curlArgsFile}"
for arg in "$@"; do
  if [ "$arg" = "@-" ]; then
    cat > "${curlStdinFile}"
    break
  fi
done
printf "%s" "${escapedOutput}"
exit ${curlExit}
`;
  writeFileSync(resolve(mockBinDir, "curl"), mockCurl, { mode: 0o755 });

  return { dir, runtimeDir, mockBinDir, curlArgsFile, curlStdinFile };
}

function cleanup(env: TestEnv) {
  rmSync(env.dir, { recursive: true, force: true });
  rmSync(env.runtimeDir, { recursive: true, force: true });
}

function makeInput(toolInput: Record<string, unknown>, cwd: string): string {
  return JSON.stringify({
    tool_name: "AskUserQuestion",
    tool_input: toolInput,
    cwd,
  });
}

/** Real single-question input shape (captured from a live transcript). */
function singleQuestionInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: "claude-hub#342 の対策方式はどれで確定しますか？",
        header: "342方式",
        multiSelect: false,
        options: [
          {
            label: "案B-lite（推奨）",
            description: "完了判定を git 成果物ベースに変更",
          },
          {
            label: "案A: tmux 既定化",
            description: "dispatch セッションを tmux 常駐にして予防",
          },
        ],
      },
    ],
  };
}

async function runHook(
  env: TestEnv,
  input: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await $`echo ${input} | PATH=${env.mockBinDir}:$PATH XDG_RUNTIME_DIR=${env.runtimeDir} bash ${HOOK_PATH}`
    .quiet()
    .nothrow();
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe("ask-user-relay.sh — supervisor session active", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/thread-abc",
      curlOutput: '{"answer":"案B-lite（推奨）"}',
    });
  });

  afterEach(() => cleanup(env));

  test("forwards question + options to /ask/ and emits deny envelope carrying the user's reply", async () => {
    const input = makeInput(singleQuestionInput(), env.dir);

    const { stdout, exitCode } = await runHook(env, input);
    expect(exitCode).toBe(0);

    // /ask/ URL must be derived from /relay/, not double-encoded.
    const curlArgs = readFileSync(env.curlArgsFile, "utf8");
    expect(curlArgs).toContain("http://localhost:12345/ask/thread-abc");
    expect(curlArgs).not.toContain("\\/");

    // Outbound JSON sent to relay-server: question text + flattened options.
    const sent = JSON.parse(readFileSync(env.curlStdinFile, "utf8"));
    expect(sent.question).toBe(
      "claude-hub#342 の対策方式はどれで確定しますか？",
    );
    expect(sent.options).toEqual([
      "案B-lite（推奨） — 完了判定を git 成果物ベースに変更",
      "案A: tmux 既定化 — dispatch セッションを tmux 常駐にして予防",
    ]);

    // Hook stdout: PreToolUse deny whose reason carries the answer. The
    // wording mirrors the native answered-dialog tool_result ("Your questions
    // have been answered: ...") so Claude treats it as an answer, not a
    // refusal, and continues the turn.
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      'Your questions have been answered:',
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      '"claude-hub#342 の対策方式はどれで確定しますか？"="案B-lite（推奨）"',
    );
  });

  test("multiple questions: the joined question text AND a structured questions[] (with options) are both forwarded (#443)", async () => {
    const input = makeInput(
      {
        questions: [
          { question: "Q1 はどうしますか？", header: "Q1", multiSelect: false, options: [{ label: "a", description: "d1" }] },
          { question: "Q2 はどうしますか？", header: "Q2", multiSelect: true, options: [{ label: "b", description: "d2" }] },
        ],
      },
      env.dir,
    );

    const { exitCode } = await runHook(env, input);
    expect(exitCode).toBe(0);

    const sent = JSON.parse(readFileSync(env.curlStdinFile, "utf8"));
    // `question` stays the flattened, joined form — unchanged, still used for
    // the deny-envelope wording and the expiry notice.
    expect(sent.question).toContain("Q1 はどうしますか？");
    expect(sent.question).toContain("Q2 はどうしますか？");
    expect(sent.options).toBeUndefined();
    // Issue #443: `questions[]` carries each sub-question's own text +
    // flattened options, so Discord can post a tappable row per question
    // instead of falling back to one free-text reply for the whole batch.
    expect(sent.questions).toEqual([
      { question: "Q1 はどうしますか？", multiSelect: false, options: ["a — d1"] },
      { question: "Q2 はどうしますか？", multiSelect: true, options: ["b — d2"] },
    ]);
  });

  test("multiple questions where one has no options: that question's options key is omitted, not an empty array", async () => {
    const input = makeInput(
      {
        questions: [
          { question: "Q1 はどうしますか？", header: "Q1", multiSelect: false, options: [{ label: "a", description: "" }] },
          { question: "Q2 は自由記述です", header: "Q2", multiSelect: false, options: [] },
        ],
      },
      env.dir,
    );

    const { exitCode } = await runHook(env, input);
    expect(exitCode).toBe(0);

    const sent = JSON.parse(readFileSync(env.curlStdinFile, "utf8"));
    expect(sent.questions[0]).toEqual({
      question: "Q1 はどうしますか？",
      multiSelect: false,
      options: ["a"],
    });
    expect(sent.questions[1]).toEqual({
      question: "Q2 は自由記述です",
      multiSelect: false,
    });
    expect(sent.questions[1].options).toBeUndefined();
  });
});

describe("ask-user-relay.sh — URL derivation safety", () => {
  // Regression: bash `${VAR/pat/repl}` would replace the FIRST `relay` token
  // anywhere in the URL (including the host name or a threadId). Path-segment
  // sed replacement keeps the substitution scoped to `/relay/` only
  // (review: gemini-code-assist on PR #142, comment 3179491537).
  test("only the /relay/ path segment is replaced — host containing 'relay' is preserved", async () => {
    const env = setupTestEnv({
      relayUrl: "http://relay.example.com:12345/relay/thread-x",
      curlOutput: '{"answer":"ok"}',
    });
    try {
      const input = makeInput(singleQuestionInput(), env.dir);
      await runHook(env, input);
      const curlArgs = readFileSync(env.curlArgsFile, "utf8");
      expect(curlArgs).toContain(
        "http://relay.example.com:12345/ask/thread-x",
      );
      expect(curlArgs).not.toContain("ask.example.com");
    } finally {
      cleanup(env);
    }
  });

  test("threadId containing 'relay' is preserved when deriving /ask/ URL", async () => {
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/relay-debug-thread",
      curlOutput: '{"answer":"ok"}',
    });
    try {
      const input = makeInput(singleQuestionInput(), env.dir);
      await runHook(env, input);
      const curlArgs = readFileSync(env.curlArgsFile, "utf8");
      expect(curlArgs).toContain(
        "http://localhost:12345/ask/relay-debug-thread",
      );
    } finally {
      cleanup(env);
    }
  });
});

describe("ask-user-relay.sh — fallback / safety", () => {
  test("no relay-url file: hook is a no-op (empty stdout, exit 0)", async () => {
    const env = setupTestEnv({}); // no relayUrl written
    try {
      const input = makeInput(singleQuestionInput(), env.dir);
      const { stdout, exitCode } = await runHook(env, input);
      // AC-3 / Journey-AC #3: hook must produce no stdout when not in a
      // supervisor session — Claude proceeds with original tool_input.
      expect(stdout.trim()).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      cleanup(env);
    }
  });

  test("empty tool_input: hook exits 0 with no stdout", async () => {
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/t",
      curlOutput: '{"answer":"x"}',
    });
    try {
      const input = makeInput({}, env.dir);
      const { stdout, exitCode } = await runHook(env, input);
      expect(stdout.trim()).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      cleanup(env);
    }
  });

  test("legacy flat shape (question at top level, no questions[]): TUI fallback", async () => {
    // Issue #370 (D2): the tool never sends this shape. An unknown shape must
    // fall through to the TUI dialog, never emit a half-built deny envelope.
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/t",
      curlOutput: '{"answer":"x"}',
    });
    try {
      const input = makeInput({ question: "hi" }, env.dir);
      const { stdout, exitCode } = await runHook(env, input);
      expect(stdout.trim()).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      cleanup(env);
    }
  });

  test("supervisor returns 504-style empty answer: hook is a no-op (TUI fallback)", async () => {
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/t",
      curlOutput: '{"error":"ask timeout"}',
    });
    try {
      const input = makeInput(singleQuestionInput(), env.dir);
      const { stdout, exitCode } = await runHook(env, input);
      expect(stdout.trim()).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      cleanup(env);
    }
  });

  test("curl fails (network error): hook is a no-op (no stdout, exit 0)", async () => {
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/t",
      curlOutput: "",
      curlExit: 7, // CURLE_COULDNT_CONNECT
    });
    try {
      const input = makeInput(singleQuestionInput(), env.dir);
      const { stdout, exitCode } = await runHook(env, input);
      expect(stdout.trim()).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      cleanup(env);
    }
  });

  test("missing cwd in hook JSON: hook exits 0 silently", async () => {
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/t",
      curlOutput: '{"answer":"x"}',
    });
    try {
      const input = JSON.stringify({
        tool_name: "AskUserQuestion",
        tool_input: singleQuestionInput(),
        // no `cwd`
      });
      const { stdout, exitCode } = await runHook(env, input);
      expect(stdout.trim()).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      cleanup(env);
    }
  });
});
