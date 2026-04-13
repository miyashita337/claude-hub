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
  writeFileSync(resolve(dir, ".supervisor-relay-url"), relayUrl, "utf8");

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

  return { dir, curlArgsFile, curlStdinFile, mockBinDir };
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
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
    cleanup(env.dir);
  });

  test("PROGRESS_URL has no backslash-escaped slashes", async () => {
    const input = makeInput("Bash", { command: "echo test" }, env.dir);

    await $`echo ${input} | PATH=${env.mockBinDir}:$PATH bash ${HOOK_PATH}`
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
// Test 2: Static analysis — manager.ts writes .supervisor-relay-url
// ---------------------------------------------------------------------------
describe("manager.ts .supervisor-relay-url write", () => {
  test("start() contains printf to .supervisor-relay-url in tmux command", () => {
    const managerSource = readFileSync(
      resolve(import.meta.dir, "../../src/session/manager.ts"),
      "utf8"
    );

    // The tmux command string should include writing the relay URL file
    expect(managerSource).toMatch(/\.supervisor-relay-url/);
    // Check for the printf pattern that writes the relay URL (double-quoted for tmux safety)
    expect(managerSource).toMatch(
      /printf\s+"%s"\s+.*\.supervisor-relay-url/
    );
  });

  test("start() does NOT use writeFileSync (printf in tmux is sufficient)", () => {
    const managerSource = readFileSync(
      resolve(import.meta.dir, "../../src/session/manager.ts"),
      "utf8"
    );

    // writeFileSync for relay URL should have been removed
    expect(managerSource).not.toMatch(/writeFileSync\(relayUrlFile/);
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
    cleanup(env.dir);
  });

  async function runHookAndGetMessage(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<{ tool: string; message: string } | null> {
    const input = makeInput(toolName, toolInput, env.dir);

    await $`echo ${input} | PATH=${env.mockBinDir}:$PATH bash ${HOOK_PATH}`
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
      'printf "%s" "http://localhost:12345/relay/thread-abc" > "/tmp/project/.supervisor-relay-url"',
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
