// supervisor/tests/hooks/progress-relay.test.ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/progress-relay.sh");

/**
 * Helper: create a temp dir with .supervisor-relay-url and a mock curl script.
 * Returns { dir, curlArgsFile, mockBinDir } for assertions.
 */
function setupTestEnv(relayUrl: string) {
  const dir = mkdtempSync(resolve(tmpdir(), "progress-relay-test-"));

  // Issue #88: relay URL file lives in $XDG_RUNTIME_DIR/claude-hub-supervisor/
  // keyed by sanitised cwd, NOT inside the project dir.
  const runtimeDir = mkdtempSync(resolve(tmpdir(), "progress-relay-runtime-"));
  const sanitisedCwd = dir.replace(/^\/+/, "").replace(/\//g, "_");
  const relayDir = resolve(runtimeDir, "claude-hub-supervisor");
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(
    resolve(relayDir, `${sanitisedCwd}.relay-url`),
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

function makeInput(toolName: string, toolInput: Record<string, unknown>, cwd: string): string {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd });
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
    const input = makeInput("Bash", { command: "echo test" }, env.dir);

    await $`echo ${input} | PATH=${env.mockBinDir}:$PATH XDG_RUNTIME_DIR=${env.runtimeDir} bash ${HOOK_PATH}`
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

  test("relayUrlFilePath sanitises cwd into $XDG_RUNTIME_DIR/claude-hub-supervisor/<sanitised>.relay-url", async () => {
    const { relayUrlFilePath } = await import("../../src/session/manager");
    const result = relayUrlFilePath("/Users/x/team_salary");
    // Default to /tmp when XDG_RUNTIME_DIR is unset
    expect(result).toMatch(
      /\/claude-hub-supervisor\/Users_x_team_salary\.relay-url$/
    );
  });

  test("relayUrlFilePath honours XDG_RUNTIME_DIR when set", async () => {
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
    const input = makeInput(toolName, toolInput, env.dir);

    await $`echo ${input} | PATH=${env.mockBinDir}:$PATH XDG_RUNTIME_DIR=${env.runtimeDir} bash ${HOOK_PATH}`
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
      'mkdir -p "/tmp/claude-hub-supervisor"',
      'printf "%s" "http://localhost:12345/relay/thread-abc" > "/tmp/claude-hub-supervisor/tmp_project.relay-url"',
      'cd "/tmp/project"',
      'exec /tmp/claude --dangerously-skip-permissions --name "my-channel"',
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
