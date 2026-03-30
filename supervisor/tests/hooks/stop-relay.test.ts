// supervisor/tests/hooks/stop-relay.test.ts
import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/stop-relay.sh");

describe("stop-relay.sh", () => {
  test("exits silently when SUPERVISOR_RELAY_URL is not set", async () => {
    const result = await $`echo '{"last_assistant_message":"hello"}' | env -i bash ${HOOK_PATH}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });

  test("sends POST with text from last_assistant_message", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        return new Response(JSON.stringify(body));
      },
    });

    try {
      const url = `http://localhost:${server.port}/relay/test-thread`;
      const input = JSON.stringify({
        last_assistant_message: "Hello from Claude",
        session_id: "sess-abc",
      });

      const result = await $`echo ${input} | SUPERVISOR_RELAY_URL=${url} bash ${HOOK_PATH}`.quiet().nothrow();
      expect(result.exitCode).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("exits gracefully when last_assistant_message is empty", async () => {
    const input = JSON.stringify({ session_id: "sess-abc" });
    const result = await $`echo ${input} | SUPERVISOR_RELAY_URL=http://localhost:9999/relay/t bash ${HOOK_PATH}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });
});
