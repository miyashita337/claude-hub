// supervisor/tests/hooks/stop-relay.test.ts
import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/stop-relay.sh");

/** Capture the single POST body the hook sends, or null if it never posts. */
async function capturePost(
  input: string
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured = (await req.json()) as Record<string, unknown>;
      return new Response("ok");
    },
  });
  try {
    const url = `http://localhost:${server.port}/relay/test-thread`;
    const result =
      await $`echo ${input} | SUPERVISOR_RELAY_URL=${url} bash ${HOOK_PATH}`
        .quiet()
        .nothrow();
    expect(result.exitCode).toBe(0);
  } finally {
    server.stop(true);
  }
  return captured;
}

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

  // --- Issue #204: context_tokens computation -------------------------------

  test("omits context_tokens when no transcript_path is given (backward compat)", async () => {
    const body = await capturePost(
      JSON.stringify({ last_assistant_message: "hi", session_id: "s1" })
    );
    expect(body).not.toBeNull();
    expect(body!.text).toBe("hi");
    expect(body!.session_id).toBe("s1");
    expect("context_tokens" in body!).toBe(false);
  });

  test("computes context_tokens from the last usage entry of the transcript", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "stop-relay-"));
    const transcript = resolve(dir, "session.jsonl");
    // Two usage-bearing lines; only the LAST counts as the current context.
    // Last = 10 + 290000 + 10000 = 300010.
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), // no usage
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 290000, cache_creation_input_tokens: 10000 } },
      }),
    ];
    writeFileSync(transcript, lines.join("\n") + "\n");
    try {
      const body = await capturePost(
        JSON.stringify({
          last_assistant_message: "done",
          session_id: "s2",
          transcript_path: transcript,
        })
      );
      expect(body).not.toBeNull();
      expect(body!.text).toBe("done");
      expect(body!.context_tokens).toBe(300010);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("omits context_tokens when the transcript has no usage entries", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "stop-relay-"));
    const transcript = resolve(dir, "session.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n"
    );
    try {
      const body = await capturePost(
        JSON.stringify({
          last_assistant_message: "done",
          session_id: "s3",
          transcript_path: transcript,
        })
      );
      expect(body).not.toBeNull();
      expect("context_tokens" in body!).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds the last usage even in a large (>400-line) transcript (tail bound)", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "stop-relay-"));
    const transcript = resolve(dir, "session.jsonl");
    // 450 non-usage filler lines, then the current turn's usage as the LAST
    // line — the realistic shape (Stop hook fires right after the turn). The
    // tail -n 400 bound must still capture it. Last = 1 + 360000 + 0 = 360001.
    const filler: string[] = [];
    for (let i = 0; i < 450; i++) {
      filler.push(JSON.stringify({ type: "user", message: { role: "user", content: `m${i}` } }));
    }
    filler.push(
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 1, cache_read_input_tokens: 360000, cache_creation_input_tokens: 0 } },
      })
    );
    writeFileSync(transcript, filler.join("\n") + "\n");
    try {
      const body = await capturePost(
        JSON.stringify({
          last_assistant_message: "done",
          session_id: "s5",
          transcript_path: transcript,
        })
      );
      expect(body).not.toBeNull();
      expect(body!.context_tokens).toBe(360001);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("omits context_tokens when transcript_path points to a missing file", async () => {
    const body = await capturePost(
      JSON.stringify({
        last_assistant_message: "done",
        session_id: "s4",
        transcript_path: "/no/such/transcript-204.jsonl",
      })
    );
    expect(body).not.toBeNull();
    expect("context_tokens" in body!).toBe(false);
  });
});
