import { test, expect, describe } from "bun:test";
import { createSessionHandler } from "../../src/commands/session";

/**
 * Handler-level tests for `/session keep <filename>` (Issue #193).
 *
 * Mirrors session-compact.test.ts: a minimal fake ChatInputCommandInteraction
 * drives the real handler without a Discord gateway. The file-move logic itself
 * is covered exhaustively in tests/session/keep-attachment.test.ts; here we only
 * assert the Discord dispatch branches that are filesystem-free or read-only:
 *   - missing filename → usage hint (flags 64), no defer
 *   - a non-existent file → KeepError surfaced via editReply (never silent)
 */

interface ReplyRecord {
  kind: "reply" | "editReply";
  content?: string;
  flags?: number;
}

function makeInteraction(opts: { filename?: string | null }) {
  const replies: ReplyRecord[] = [];
  const interaction = {
    options: {
      getSubcommand: () => "keep",
      getString: (name: string) =>
        name === "filename" ? opts.filename ?? null : null,
    },
    channel: { id: "thread-keep-1", isThread: () => true },
    deferred: false,
    replied: false,
    async reply(msg: { content?: string; flags?: number }) {
      this.replied = true;
      replies.push({ kind: "reply", content: msg.content, flags: msg.flags });
    },
    async deferReply(msg?: { flags?: number }) {
      this.deferred = true;
      replies.push({ kind: "reply", flags: msg?.flags });
    },
    async editReply(msg: { content?: string }) {
      replies.push({ kind: "editReply", content: msg.content });
    },
  };

  // /session keep does not touch the SessionManager; a no-op stub suffices.
  const sessionManager = {};

  return {
    run: () =>
      createSessionHandler(sessionManager as never)(interaction as never),
    replies,
  };
}

describe("/session keep (#193)", () => {
  test("missing filename: usage hint, ephemeral, no defer", async () => {
    const fx = makeInteraction({ filename: null });
    await fx.run();

    const hint = fx.replies.find((r) => r.kind === "reply" && r.content);
    expect(hint?.content).toContain("filename が必須");
    expect(hint?.flags).toBe(64);
    // Must not have deferred (no work attempted).
    expect(fx.replies.some((r) => r.kind === "editReply")).toBe(false);
  });

  test("whitespace-only filename: treated as missing (usage hint)", async () => {
    const fx = makeInteraction({ filename: "   " });
    await fx.run();
    const hint = fx.replies.find((r) => r.kind === "reply" && r.content);
    expect(hint?.content).toContain("filename が必須");
  });

  test("non-existent file: KeepError surfaced via editReply (no silent success)", async () => {
    // A name that is a valid basename but is overwhelmingly unlikely to exist in
    // the real ATTACHMENT_DIR. keepAttachment stat()s it, hits ENOENT, and
    // throws KeepError before creating anything (read-only, no side effects).
    const fx = makeInteraction({
      filename: "__keep_test_missing_193__.bin",
    });
    await fx.run();

    const err = fx.replies.find((r) => r.kind === "editReply" && r.content);
    expect(err?.content).toContain("❌");
    expect(err?.content).toContain("見つかりません");
  });

  test("path-traversal filename: rejected via editReply, never silent", async () => {
    const fx = makeInteraction({ filename: "../../etc/passwd" });
    await fx.run();

    const err = fx.replies.find((r) => r.kind === "editReply" && r.content);
    expect(err?.content).toContain("❌");
    expect(err?.content).toContain("不正なファイル名");
  });
});
