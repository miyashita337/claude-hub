import { test, expect, describe } from "bun:test";
import {
  relayInteractive,
  INTERACTIVE_INPUT_READY_ATTEMPTS,
} from "../../src/session/interactive-relay";
import type { RelayResult } from "../../src/session/relay";

/**
 * Issue #357: the dispatch (dispatch.ts) and orchestrate (orchestrate.ts)
 * transports wait for the TUI to be input-ready before injecting text, but the
 * interactive Discord relay in bot.ts went straight to `sendMessage`. A message
 * that lands while the TUI is still booting (e.g. right after an auto-resume,
 * #456) is typed into a TUI that is not accepting input yet, and the Enter that
 * follows is lost — the un-submitted stall in the issue.
 *
 * `relayInteractive` is the bot-side seam: readiness first, then the relay.
 * Readiness is best-effort, exactly like dispatch: a timeout or a throwing
 * probe must never block the message.
 */

const OK: RelayResult = { text: "ok", chunks: ["ok"] };

function makeDeps(ready: () => Promise<boolean>) {
  const order: string[] = [];
  const sent: { threadId: string; message: string }[] = [];
  const attempts: (number | undefined)[] = [];
  return {
    order,
    attempts,
    sent,
    deps: {
      waitForInputReady: async (threadId: string, maxAttempts?: number) => {
        order.push(`ready:${threadId}`);
        attempts.push(maxAttempts);
        return ready();
      },
      sendMessage: async (threadId: string, message: string) => {
        order.push(`send:${threadId}`);
        sent.push({ threadId, message });
        return OK;
      },
    },
  };
}

describe("relayInteractive (#357)", () => {
  test("waits for input readiness BEFORE relaying the message", async () => {
    const { deps, order, sent } = makeDeps(async () => true);
    const result = await relayInteractive(deps, "t1", "hello");
    expect(order).toEqual(["ready:t1", "send:t1"]);
    expect(sent).toEqual([{ threadId: "t1", message: "hello" }]);
    expect(result).toBe(OK);
  });

  test("uses a short readiness budget, not the dispatch boot budget", async () => {
    const { deps, attempts } = makeDeps(async () => true);
    await relayInteractive(deps, "t0", "hello");
    expect(attempts).toEqual([INTERACTIVE_INPUT_READY_ATTEMPTS]);
    expect(INTERACTIVE_INPUT_READY_ATTEMPTS).toBeLessThanOrEqual(15);
  });

  test("still relays (best-effort) when readiness times out", async () => {
    const { deps, order } = makeDeps(async () => false);
    const result = await relayInteractive(deps, "t2", "hello");
    expect(order).toEqual(["ready:t2", "send:t2"]);
    expect(result).toBe(OK);
  });

  test("still relays when the readiness probe throws", async () => {
    const { deps, order } = makeDeps(async () => {
      throw new Error("capture-pane boom");
    });
    const result = await relayInteractive(deps, "t3", "hello");
    expect(order).toEqual(["ready:t3", "send:t3"]);
    expect(result).toBe(OK);
  });

  test("forwards attachments and relay options untouched", async () => {
    const calls: unknown[][] = [];
    const onDialogStuck = () => {};
    const attachments = [{ url: "u", filename: "f.png", contentType: "image/png" }];
    await relayInteractive(
      {
        waitForInputReady: async () => true,
        sendMessage: async (...args: unknown[]) => {
          calls.push(args);
          return OK;
        },
      },
      "t4",
      "msg",
      attachments,
      { onDialogStuck }
    );
    expect(calls).toEqual([["t4", "msg", attachments, { onDialogStuck }]]);
  });
});
