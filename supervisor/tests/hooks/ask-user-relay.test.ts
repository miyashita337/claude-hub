// supervisor/tests/hooks/ask-user-relay.test.ts (Issue #12 Phase 1)
//
// Black-box test for hooks/ask-user-relay.sh. Uses a mock curl to capture the
// outbound POST and feed back a synthetic supervisor reply, then asserts the
// hook's stdout produces the PreToolUse `updatedInput` envelope so Claude
// resumes with the user's answer instead of blocking on the TUI dialog.
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
      curlOutput: '{"answer":"use PR #42"}',
    });
  });

  afterEach(() => cleanup(env));

  test("forwards question to /ask/ and emits updatedInput with the user's reply", async () => {
    const input = makeInput(
      { question: "Which PR did you mean?" },
      env.dir,
    );

    const { stdout, exitCode } = await runHook(env, input);
    expect(exitCode).toBe(0);

    // /ask/ URL must be derived from /relay/, not double-encoded.
    const curlArgs = readFileSync(env.curlArgsFile, "utf8");
    expect(curlArgs).toContain("http://localhost:12345/ask/thread-abc");
    expect(curlArgs).not.toContain("\\/");

    // Outbound JSON sent to relay-server.
    const sent = JSON.parse(readFileSync(env.curlStdinFile, "utf8"));
    expect(sent.question).toBe("Which PR did you mean?");

    // Hook stdout: PreToolUse hookSpecificOutput with updatedInput.
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.updatedInput.question).toBe("use PR #42");
  });

  test("accepts `prompt` field as fallback for the question text", async () => {
    const input = makeInput({ prompt: "Pick a path" }, env.dir);
    await runHook(env, input);
    const sent = JSON.parse(readFileSync(env.curlStdinFile, "utf8"));
    expect(sent.question).toBe("Pick a path");
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
      const input = makeInput({ question: "ping" }, env.dir);
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
      const input = makeInput({ question: "ping" }, env.dir);
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
      const input = makeInput({ question: "hi" }, env.dir);
      const { stdout, exitCode } = await runHook(env, input);
      // AC-3 / Journey-AC #3: hook must produce no stdout when not in a
      // supervisor session — Claude proceeds with original tool_input.
      expect(stdout.trim()).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      cleanup(env);
    }
  });

  test("missing question/prompt: hook exits 0 with no stdout", async () => {
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

  test("supervisor returns 504-style empty answer: hook is a no-op (TUI fallback)", async () => {
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/t",
      curlOutput: '{"error":"ask timeout"}',
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

  test("curl fails (network error): hook is a no-op (no stdout, exit 0)", async () => {
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/t",
      curlOutput: "",
      curlExit: 7, // CURLE_COULDNT_CONNECT
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

  test("missing cwd in hook JSON: hook exits 0 silently", async () => {
    const env = setupTestEnv({
      relayUrl: "http://localhost:12345/relay/t",
      curlOutput: '{"answer":"x"}',
    });
    try {
      const input = JSON.stringify({
        tool_name: "AskUserQuestion",
        tool_input: { question: "hi" },
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
