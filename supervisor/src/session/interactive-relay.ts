import type { AttachmentInfo, RelayMessageOptions, RelayResult } from "./relay";

/** The slice of SessionManager the interactive relay needs (unit-testable). */
export interface InteractiveRelayDeps {
  waitForInputReady(threadId: string, maxAttempts?: number): Promise<boolean>;
  sendMessage(
    threadId: string,
    message: string,
    attachments?: AttachmentInfo[],
    options?: Pick<RelayMessageOptions, "onDialogStuck">
  ): Promise<RelayResult>;
}

/**
 * Poll budget (× the manager's 1s interval) for the interactive path. Short on
 * purpose: this runs before EVERY Discord message, and when the marker is
 * hidden (Claude busy, input box holding text) the wait is pure latency. Long
 * enough to cover a TUI that is still booting after an auto-resume.
 */
export const INTERACTIVE_INPUT_READY_ATTEMPTS = 10;

/**
 * Issue #357: relay a Discord message into the thread's TUI only after the TUI
 * is ready for input — the same wait the dispatch (dispatch.ts) and orchestrate
 * (orchestrate.ts) transports already do. Without it, a message that arrives
 * while the TUI is still booting (e.g. right after an auto-resume, #456) is
 * typed into a TUI that is not accepting input and its Enter is lost.
 *
 * Best-effort, like dispatch: a readiness timeout or a throwing probe is logged
 * and the message is relayed anyway — a missed marker must never swallow it.
 */
export async function relayInteractive(
  deps: InteractiveRelayDeps,
  threadId: string,
  message: string,
  attachments?: AttachmentInfo[],
  options?: Pick<RelayMessageOptions, "onDialogStuck">
): Promise<RelayResult> {
  try {
    const ready = await deps.waitForInputReady(
      threadId,
      INTERACTIVE_INPUT_READY_ATTEMPTS
    );
    if (!ready) {
      console.warn(
        `[Relay] input-ready marker not seen for thread ${threadId}; relaying anyway (best-effort)`
      );
    }
  } catch (err) {
    console.warn(
      `[Relay] waitForInputReady failed for thread ${threadId}; relaying anyway:`,
      err instanceof Error ? err.message : String(err)
    );
  }
  return deps.sendMessage(threadId, message, attachments, options);
}
