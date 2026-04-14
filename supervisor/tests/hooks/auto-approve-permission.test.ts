import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/auto-approve-permission.sh");

describe("auto-approve-permission.sh", () => {
  test("exits silently when SUPERVISOR_RELAY_URL is not set", async () => {
    const input = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } });
    const result = await $`echo ${input} | env -i PATH=${process.env.PATH} bash ${HOOK_PATH}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  test("returns allow decision when SUPERVISOR_RELAY_URL is set", async () => {
    const input = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/.claude/commands/x.md" },
    });
    const result = await $`echo ${input} | SUPERVISOR_RELAY_URL=http://localhost:9999/relay/t bash ${HOOK_PATH}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(output.hookSpecificOutput.decision.behavior).toBe("allow");
  });

  test("handles Bash tool by reading command field", async () => {
    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls /etc" },
    });
    const result = await $`echo ${input} | SUPERVISOR_RELAY_URL=http://localhost:9999/relay/t bash ${HOOK_PATH}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.hookSpecificOutput.decision.behavior).toBe("allow");
  });
});
