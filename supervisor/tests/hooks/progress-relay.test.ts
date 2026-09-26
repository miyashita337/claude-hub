// supervisor/tests/hooks/progress-relay.test.ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/progress-relay.sh");

const DEFAULT_SESSION_ID = "sess-default";

/**
 * Helper: create a temp dir with a relay-url file (fallback path, keyed by
 * `sessionId` — Issue #149/#150, NOT cwd) and a mock curl script.
 * Returns { dir, curlArgsFile, mockBinDir } for assertions.
 */
function setupTestEnv(relayUrl: string, sessionId: string = DEFAULT_SESSION_ID) {
  const dir = mkdtempSync(resolve(tmpdir(), "progress-relay-test-"));

  // Issue #88: relay URL file lives in $XDG_RUNTIME_DIR/claude-hub-supervisor/.
  // Issue #149/#150: keyed by the session's claudeSessionId, NOT the project
  // cwd — two sessions sharing a cwd must not collide on one file.
  const runtimeDir = mkdtempSync(resolve(tmpdir(), "progress-relay-runtime-"));
  const sanitisedSessionId = sessionId.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  const relayDir = resolve(runtimeDir, "claude-hub-supervisor");
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(
    resolve(relayDir, `${sanitisedSessionId}.relay-url`),
    relayUrl,
    "utf8",
  );

  // Mock curl: writes all args to a file, reads stdin -d @- and writes it too
  const mockBinDir = resolve(dir, "mock-bin");
  mkdirSync(mockBinDir, { recursive: true });

  const curlArgsFile = resolve(dir, "curl-args.txt");
  const curlStdinFile = resolve(dir, "curl-stdin.json");

  // The mock curl captures args and stdin data
  const mockCurl = `#!/bin/bash
echo "$@" > "${curlArgsFile}"
# Read stdin if -d @- is in the args
for arg in "$@"; do
  if [ "$arg" = "@-" ]; then
    cat > "${curlStdinFile}"
    break
  fi
done
`;
  const mockCurlPath = resolve(mockBinDir, "curl");
  writeFileSync(mockCurlPath, mockCurl, { mode: 0o755 });

  return { dir, curlArgsFile, curlStdinFile, mockBinDir, runtimeDir };
}

function cleanup(env: ReturnType<typeof setupTestEnv>) {
  rmSync(env.dir, { recursive: true, force: true });
  rmSync(env.runtimeDir, { recursive: true, force: true });
}

function makeInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string = DEFAULT_SESSION_ID,
): string {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sessionId,
  });
}

// ---------------------------------------------------------------------------
// Test 1: URL replacement — no backslash-escaped slashes
// ---------------------------------------------------------------------------
describe("progress-relay.sh URL replacement", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv("http://localhost:12345/relay/thread123");
  });

  afterEach(() => {
    cleanup(env);
  });

  test("PROGRESS_URL has no backslash-escaped slashes", async () => {
    const input = makeInput("Bash", { command: "echo test" });

    // SUPERVISOR_RELAY_URL= (empty) forces the file-fallback path so this
    // test exercises the same file this env writes.
    await $`echo ${input} | SUPERVISOR_RELAY_URL= PATH=${env.mockBinDir}:$PATH XDG_RUNTIME_DIR=${env.runtimeDir} bash ${HOOK_PATH}`
      .quiet()
      .nothrow();

    const curlArgs = readFileSync(env.curlArgsFile, "utf8");
    // The URL passed to curl should be http://localhost:12345/progress/thread123
    expect(curlArgs).toContain("http://localhost:12345/progress/thread123");
    // Must NOT contain escaped slashes like \/
    expect(curlArgs).not.toContain("\\/");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Static analysis — manager.ts writes the relay URL file via
// relayUrlFilePath() helper (Issue #88: file lives in $XDG_RUNTIME_DIR, not
// in the project repo).
// ---------------------------------------------------------------------------
describe("manager.ts relay URL write", () => {
  test("start() contains printf to the relayUrlFilePath result in tmux command", () => {
    const managerSource = readFileSync(
      resolve(import.meta.dir, "../../src/session/manager.ts"),
      "utf8"
    );

    // The tmux command string should reference the helper-derived file path
    expect(managerSource).toMatch(/relayUrlFile/);
    // Check for the printf pattern that writes the relay URL (double-quoted for tmux safety)
    expect(managerSource).toMatch(
      /printf\s+"%s"\s+"\$\{relayUrl\}"\s+>\s+"\$\{relayUrlFile\}"/
    );
    // mkdir -p must precede the printf so the runtime dir exists
    expect(managerSource).toMatch(/mkdir\s+-p\s+"\$\{relayUrlDir\}"/);
  });

  test("start() does NOT use writeFileSync (printf in tmux is sufficient)", () => {
    const managerSource = readFileSync(
      resolve(import.meta.dir, "../../src/session/manager.ts"),
      "utf8"
    );

    // writeFileSync for relay URL should have been removed
    expect(managerSource).not.toMatch(/writeFileSync\(relayUrlFile/);
  });

  test("relayUrlFilePath sanitises the session-id key and falls back to /tmp/claude-hub-supervisor-<USER> when XDG unset", async () => {
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    const originalUser = process.env.USER;
    delete process.env.XDG_RUNTIME_DIR;
    process.env.USER = "alice";
    try {
      const { relayUrlFilePath } = await import("../../src/session/manager");
      // relayUrlFilePath is a generic sanitiser (Issue #149/#150: callers now
      // pass claudeSessionId, but the function itself just sanitises whatever
      // string it is given).
      expect(relayUrlFilePath("/Users/x/team_salary")).toBe(
        "/tmp/claude-hub-supervisor-alice/Users_x_team_salary.relay-url"
      );
    } finally {
      if (originalXdg !== undefined) process.env.XDG_RUNTIME_DIR = originalXdg;
      if (originalUser !== undefined) process.env.USER = originalUser;
      else delete process.env.USER;
    }
  });

  test("relayUrlFilePath honours XDG_RUNTIME_DIR when set (per-user dir by spec)", async () => {
    const original = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = "/run/user/501";
    try {
      const { relayUrlFilePath } = await import("../../src/session/manager");
      const result = relayUrlFilePath("/Users/x/agent-base");
      expect(result).toBe(
        "/run/user/501/claude-hub-supervisor/Users_x_agent-base.relay-url"
      );
    } finally {
      if (original !== undefined) {
        process.env.XDG_RUNTIME_DIR = original;
      } else {
        delete process.env.XDG_RUNTIME_DIR;
      }
    }
  });

  test("relayUrlFilePath sanitises shell-unsafe characters (defensive)", async () => {
    const { relayUrlFilePath } = await import("../../src/session/manager");
    // double-quotes / spaces / backticks must become `_` so the resulting path
    // cannot break the printf > "${file}" tmux command
    const result = relayUrlFilePath('/Users/x/dir"with spaces`');
    expect(result).toMatch(/Users_x_dir_with_spaces_\.relay-url$/);
    expect(result).not.toContain('"');
    expect(result).not.toContain("`");
    expect(result).not.toContain(" ");
  });

  test("relayUrlFilePath strips multiple leading slashes (matches TS regex /^\\/+/)", async () => {
    const { relayUrlFilePath } = await import("../../src/session/manager");
    expect(relayUrlFilePath("///Users/x/foo")).toMatch(
      /\/Users_x_foo\.relay-url$/
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3: E2E — tool type → message extraction
// ---------------------------------------------------------------------------
describe("progress-relay.sh tool message extraction", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv("http://localhost:12345/relay/thread123");
  });

  afterEach(() => {
    cleanup(env);
  });

  async function runHookAndGetMessage(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<{ tool: string; message: string } | null> {
    const input = makeInput(toolName, toolInput);

    // SUPERVISOR_RELAY_URL= (empty) forces the file-fallback path.
    await $`echo ${input} | SUPERVISOR_RELAY_URL= PATH=${env.mockBinDir}:$PATH XDG_RUNTIME_DIR=${env.runtimeDir} bash ${HOOK_PATH}`
      .quiet()
      .nothrow();

    try {
      const stdinData = readFileSync(env.curlStdinFile, "utf8");
      return JSON.parse(stdinData);
    } catch {
      // curl was not called (no stdin file)
      return null;
    }
  }

  test("Bash: extracts command as target", async () => {
    const result = await runHookAndGetMessage("Bash", {
      command: "git status",
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Bash");
    expect(result!.message.trim()).toBe("git status");
  });

  test("Read: extracts basename of file_path", async () => {
    const result = await runHookAndGetMessage("Read", {
      file_path: "/Users/foo/bar/baz.ts",
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Read");
    expect(result!.message).toBe("baz.ts");
  });

  test("Grep: extracts pattern and path", async () => {
    const result = await runHookAndGetMessage("Grep", {
      pattern: "TODO",
      path: "src/",
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Grep");
    expect(result!.message).toBe("TODO (src/)");
  });

  test("Agent: extracts [subagent_type] description", async () => {
    const result = await runHookAndGetMessage("Agent", {
      description: "Code review",
      subagent_type: "code-reviewer",
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Agent");
    expect(result!.message).toBe("[code-reviewer] Code review");
  });

  test("Unknown tool: sends fallback message", async () => {
    const result = await runHookAndGetMessage("Unknown", {});
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Unknown");
    expect(result!.message).toBe("(実行完了)");
  });
});

// ---------------------------------------------------------------------------
// Test 3b (Issue #149/#150): $SUPERVISOR_RELAY_URL env var takes priority
// over the relay-url file, and is used even when no file exists at all.
// ---------------------------------------------------------------------------
describe("progress-relay.sh SUPERVISOR_RELAY_URL env priority (#149/#150)", () => {
  test("env var is used directly when set, without touching any file", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "progress-relay-env-test-"));
    const runtimeDir = mkdtempSync(resolve(tmpdir(), "progress-relay-env-runtime-"));
    const mockBinDir = resolve(dir, "mock-bin");
    mkdirSync(mockBinDir, { recursive: true });
    const curlArgsFile = resolve(dir, "curl-args.txt");
    writeFileSync(
      resolve(mockBinDir, "curl"),
      `#!/bin/bash\necho "$@" > "${curlArgsFile}"\n`,
      { mode: 0o755 },
    );
    try {
      // No relay-url file is written anywhere under runtimeDir — env alone
      // must be enough.
      const input = makeInput("Bash", { command: "echo test" }, "sess-env-only");
      await $`echo ${input} | SUPERVISOR_RELAY_URL="http://localhost:9/relay/thread-env" PATH=${mockBinDir}:$PATH XDG_RUNTIME_DIR=${runtimeDir} bash ${HOOK_PATH}`
        .quiet()
        .nothrow();

      const curlArgs = readFileSync(curlArgsFile, "utf8");
      expect(curlArgs).toContain("http://localhost:9/progress/thread-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test("env var wins over a stale/conflicting relay-url file for the same session", async () => {
    const env = setupTestEnv(
      "http://localhost:9/relay/thread-from-file",
      "sess-conflict",
    );
    try {
      const input = makeInput("Bash", { command: "echo test" }, "sess-conflict");
      await $`echo ${input} | SUPERVISOR_RELAY_URL="http://localhost:9/relay/thread-from-env" PATH=${env.mockBinDir}:$PATH XDG_RUNTIME_DIR=${env.runtimeDir} bash ${HOOK_PATH}`
        .quiet()
        .nothrow();

      const curlArgs = readFileSync(env.curlArgsFile, "utf8");
      expect(curlArgs).toContain("http://localhost:9/progress/thread-from-env");
      expect(curlArgs).not.toContain("thread-from-file");
    } finally {
      cleanup(env);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3c (Issue #149/#150 regression): two concurrent sessions sharing the
// SAME cwd must route to their own Discord thread, not the last-started
// one's. This is the exact bug reported in #149/#150 — the file used to be
// keyed by cwd, so the second session's write silently clobbered the first's.
// ---------------------------------------------------------------------------
describe("progress-relay.sh concurrent sessions with the same cwd (#149/#150)", () => {
  test("each session's relay-url file (keyed by session_id) routes independently", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "progress-relay-multi-test-"));
    const runtimeDir = mkdtempSync(resolve(tmpdir(), "progress-relay-multi-runtime-"));
    const relayDir = resolve(runtimeDir, "claude-hub-supervisor");
    mkdirSync(relayDir, { recursive: true });
    // Two DIFFERENT sessions, both happen to run in the same project cwd —
    // exactly the setup described in #149/#150 (one repo, two Discord threads).
    writeFileSync(
      resolve(relayDir, "session-aaa.relay-url"),
      "http://localhost:9/relay/thread-A",
      "utf8",
    );
    writeFileSync(
      resolve(relayDir, "session-bbb.relay-url"),
      "http://localhost:9/relay/thread-B",
      "utf8",
    );

    const mockBinDir = resolve(dir, "mock-bin");
    mkdirSync(mockBinDir, { recursive: true });
    const curlArgsFileA = resolve(dir, "curl-args-a.txt");
    const curlArgsFileB = resolve(dir, "curl-args-b.txt");
    // Route args to a different file depending on which thread was targeted,
    // so both invocations can be asserted independently even though they
    // share one mock curl binary.
    writeFileSync(
      resolve(mockBinDir, "curl"),
      `#!/bin/bash
for arg in "$@"; do
  case "$arg" in
    */progress/thread-A) echo "$@" >> "${curlArgsFileA}" ;;
    */progress/thread-B) echo "$@" >> "${curlArgsFileB}" ;;
  esac
done
`,
      { mode: 0o755 },
    );

    try {
      const inputA = makeInput("Bash", { command: "echo from-A" }, "session-aaa");
      const inputB = makeInput("Bash", { command: "echo from-B" }, "session-bbb");

      await $`echo ${inputA} | SUPERVISOR_RELAY_URL= PATH=${mockBinDir}:$PATH XDG_RUNTIME_DIR=${runtimeDir} bash ${HOOK_PATH}`
        .quiet()
        .nothrow();
      await $`echo ${inputB} | SUPERVISOR_RELAY_URL= PATH=${mockBinDir}:$PATH XDG_RUNTIME_DIR=${runtimeDir} bash ${HOOK_PATH}`
        .quiet()
        .nothrow();

      // Regression check: session A's progress must have gone to thread A
      // ONLY, and session B's to thread B only — never cross-routed.
      expect(readFileSync(curlArgsFileA, "utf8")).toContain("thread-A");
      expect(readFileSync(curlArgsFileB, "utf8")).toContain("thread-B");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: bash -n syntax check on the tmux command string from manager.ts
// ---------------------------------------------------------------------------
describe("manager.ts tmux command syntax", () => {
  test("claudeCmd assembled by start() is valid bash syntax", async () => {
    // Reconstruct the same command shape that manager.ts builds at runtime,
    // substituting concrete dummy values for the TypeScript template expressions.
    const claudeCmd = [
      "unset ANTHROPIC_API_KEY",
      'export PATH="/tmp/.local/bin:/tmp/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"',
      'export SUPERVISOR_RELAY_URL="http://localhost:12345/relay/thread-abc"',
      'mkdir -p "/tmp/claude-hub-supervisor-alice"',
      'printf "%s" "http://localhost:12345/relay/thread-abc" > "/tmp/claude-hub-supervisor-alice/tmp_project.relay-url"',
      'cd "/tmp/project"',
      `exec /tmp/claude --dangerously-skip-permissions --name "my-channel" --no-chrome --strict-mcp-config --mcp-config '{"mcpServers":{}}'`,
    ].join(" && ");

    // Verify this matches the structure in the source
    const managerSource = readFileSync(
      resolve(import.meta.dir, "../../src/session/manager.ts"),
      "utf8"
    );
    // Ensure printf uses double quotes (not single) for tmux compatibility
    expect(managerSource).toMatch(/printf "%s"/);
    // Ensure the join pattern is " && "
    expect(managerSource).toMatch(/\.join\(" && "\)/);

    // Run bash -n to check syntax (no execution, just parse)
    const result = await $`bash -n -c ${claudeCmd}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });
});
