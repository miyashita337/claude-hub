// End-to-end coverage for the AskUserQuestion selector path (Issue #436 V-2).
//
// Issue #436 asked for a manual Discord check ("does a real button appear")
// after every supervisor restart. Two days running it never completed — not
// because the feature was broken, but because nothing in CI drove the full
// chain: hooks/ask-user-relay.sh -> relay-server /ask/:threadId -> onAskUser
// -> the Discord post. Every existing test covers one hop in isolation
// (tests/hooks/ask-user-relay.test.ts mocks curl and never touches a live
// server; tests/session/ask-user-relay.test.ts drives the server but never
// the hook process; tests/commands/ask-components.test.ts drives
// postAskUserPrompt directly but never through the hook or the server;
// tests/bot/startup-wiring.test.ts proves handleAskUser is registered but
// never executes it). This file wires all of them together with a real
// relay-server, a real `bash hooks/ask-user-relay.sh` child process, real
// curl, and a fake Discord channel standing in for the one hop that
// genuinely requires a live bot token (channel.send against the Gateway).
//
// A green run here is the automated equivalent of Issue #436's V-2 checklist
// (期待 1-4): components reach the post, the real deadline is quoted, the
// no-auto-select notice (#423) is present, and the user's tap/reply resolves
// back to the hook's PreToolUse deny envelope.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { resolve } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  startRelayServer,
  stopRelayServer,
  getRelayPort,
  onAskUser,
  resolveAskUser,
  type AskUserEvent,
} from "../../src/session/relay-server";
import {
  ASK_COMPONENT_PREFIX,
  AskPromptRegistry,
  createAskComponentHandler,
  postAskUserPrompt,
  postMultiAskUserPrompt,
  type AskPostChannel,
} from "../../src/commands/ask-components";

const HOOK_PATH = resolve(import.meta.dir, "../../hooks/ask-user-relay.sh");

interface SentMessage {
  content: string;
  components?: unknown[];
}

function makeFakeChannel() {
  const sent: SentMessage[] = [];
  const channel: AskPostChannel = {
    send: async (options) => {
      sent.push(options);
      return { id: "message-1" };
    },
  };
  return { channel, sent };
}

interface TestEnv {
  cwd: string;
  runtimeDir: string;
}

function setupEnv(relayUrl: string): TestEnv {
  const cwd = mkdtempSync(resolve(tmpdir(), "ask-user-selector-e2e-"));
  const runtimeDir = mkdtempSync(resolve(tmpdir(), "ask-user-selector-runtime-"));
  const sanitisedCwd = cwd.replace(/^\/+/, "").replace(/\//g, "_");
  const relayDir = resolve(runtimeDir, "claude-hub-supervisor");
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(resolve(relayDir, `${sanitisedCwd}.relay-url`), relayUrl, "utf8");
  return { cwd, runtimeDir };
}

function cleanupEnv(env: TestEnv) {
  rmSync(env.cwd, { recursive: true, force: true });
  rmSync(env.runtimeDir, { recursive: true, force: true });
}

function makeHookInput(cwd: string, question: string, options: string[]) {
  return JSON.stringify({
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [
        {
          question,
          header: "test",
          multiSelect: false,
          options: options.map((label) => ({ label, description: "" })),
        },
      ],
    },
    cwd,
  });
}

function makeMultiHookInput(
  cwd: string,
  questions: { question: string; options: string[] }[]
) {
  return JSON.stringify({
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: questions.map((q) => ({
        question: q.question,
        header: "test",
        multiSelect: false,
        options: q.options.map((label) => ({ label, description: "" })),
      })),
    },
    cwd,
  });
}

/** Minimal fake ButtonInteraction — just enough for createAskComponentHandler. */
function makeTap(customId: string, threadId: string) {
  return {
    customId,
    values: [],
    channelId: threadId,
    channel: { id: threadId, isThread: () => true, parentId: threadId },
    user: { id: "user-owner" },
    isStringSelectMenu: () => false,
    message: { content: "", edit: async () => {} },
    async reply() {},
    async editReply() {},
    async update() {},
  };
}

async function runHook(env: TestEnv, input: string) {
  const result = await $`echo ${input} | XDG_RUNTIME_DIR=${env.runtimeDir} bash ${HOOK_PATH}`
    .quiet()
    .nothrow();
  return {
    stdout: result.stdout.toString(),
    exitCode: result.exitCode,
  };
}

describe("AskUserQuestion selector end-to-end (Issue #436 V-2)", () => {
  let env: TestEnv;

  afterEach(() => {
    stopRelayServer();
    if (env) cleanupEnv(env);
  });

  test("hook -> relay-server -> Discord post -> user tap -> hook answer, full round trip", async () => {
    startRelayServer();
    const port = getRelayPort();
    const threadId = "thread-e2e-436";
    env = setupEnv(`http://localhost:${port}/relay/${threadId}`);

    const { channel, sent } = makeFakeChannel();

    // Mirrors bot.ts's handleAskUser exactly (Issue #370 / #412 / #416):
    // build + deliver the post the moment the hook's question arrives, then
    // simulate the user tapping a button by resolving with an answer.
    onAskUser((event: AskUserEvent) => {
      void postAskUserPrompt(channel, {
        threadId: event.threadId,
        question: event.question,
        options: event.options,
        timeoutMs: event.timeoutMs,
      }).then(() => {
        resolveAskUser(event.threadId, "A（テストOK）");
      });
    });

    const input = makeHookInput(env.cwd, "V-2検証テスト: AでもBでも選んでください", [
      "A（テストOK）",
      "B（テストOK・別選択）",
    ]);
    const { stdout, exitCode } = await runHook(env, input);

    expect(exitCode).toBe(0);

    // 期待1: the post actually reached a send() call, with buttons attached
    // (not a text-only fallback).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.components).toBeDefined();
    expect(sent[0]!.components).toHaveLength(1);

    // 期待2/3: the real deadline and the no-auto-select notice (#423) are in
    // the text that would have rendered in Discord.
    expect(sent[0]!.content).toMatch(/約 \d+(\.\d+)? (時間|分)/);
    expect(sent[0]!.content).toContain(
      "選択肢が自動で選ばれることはありません（Issue #423）",
    );

    // 期待4: the user's tap resolves the hook, which hands the answer back
    // to Claude via the PreToolUse deny envelope (same contract as the
    // hardcoded-curl hook tests, but this time the answer traveled through a
    // real relay-server round trip instead of a mocked one).
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "A（テストOK）",
    );
  });

  test("hook falls back to TUI behaviour (no relay-url) without touching Discord", async () => {
    // No relay-url file written: mirrors a non-supervisor session. Nothing
    // should be posted anywhere, and the hook must exit silently (0, no
    // stdout) so Claude Code opens its native dialog.
    env = { cwd: mkdtempSync(resolve(tmpdir(), "ask-user-selector-e2e-")), runtimeDir: mkdtempSync(resolve(tmpdir(), "ask-user-selector-runtime-")) };

    const input = makeHookInput(env.cwd, "no relay configured", ["A", "B"]);
    const { stdout, exitCode } = await runHook(env, input);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("multi-question round trip: hook -> relay -> per-question rows -> two taps -> hook answer (Issue #443)", async () => {
    startRelayServer();
    const port = getRelayPort();
    const threadId = "thread-e2e-443";
    env = setupEnv(`http://localhost:${port}/relay/${threadId}`);

    const { channel, sent } = makeFakeChannel();
    const registry = new AskPromptRegistry();
    const askComponentHandler = createAskComponentHandler({
      hasPendingAsk: () => true,
      resolveAskUser,
      registry,
      // Bypass the Discord allowlist gate — this test drives the click
      // handler directly, with no access.json configured for the fake
      // thread, and access policy itself is covered elsewhere
      // (ask-components.test.ts "tap authorization").
      checkAccess: () => ({ allowed: true, reason: "allowed" }),
    });

    // Mirrors bot.ts's handleAskUser branch for event.questions (#443): post
    // one ActionRow per question, then simulate the 会長 tapping each one in
    // turn through the REAL click handler (not a shortcut resolveAskUser
    // call) — this is what actually proves AC-1/AC-2 end to end.
    onAskUser((event: AskUserEvent) => {
      void postMultiAskUserPrompt(channel, {
        threadId: event.threadId,
        questions: event.questions ?? [],
        timeoutMs: event.timeoutMs,
      }, registry).then(async (prompt) => {
        const tokens = prompt.tokens!;
        await askComponentHandler(
          makeTap(`${ASK_COMPONENT_PREFIX}${tokens[0]}:0`, threadId) as never,
        );
        await askComponentHandler(
          makeTap(`${ASK_COMPONENT_PREFIX}${tokens[1]}:1`, threadId) as never,
        );
      }).catch((err) => {
        // CodeRabbit review (#444): an exception here would otherwise leave
        // resolveAskUser uncalled — the hook's HTTP request would then hang
        // for the full ASK_TIMEOUT_MS (5h default) and the test would time
        // out with no useful message instead of failing fast on an assertion.
        resolveAskUser(threadId, `E2E setup failed: ${err}`);
      });
    });

    const input = makeMultiHookInput(env.cwd, [
      { question: "Q1: 承認しますか？", options: ["承認", "却下"] },
      { question: "Q2: 優先度は？", options: ["高", "低"] },
    ]);
    const { stdout, exitCode } = await runHook(env, input);

    expect(exitCode).toBe(0);

    // 期待1 (AC-1): both questions reached Discord as their own tappable row,
    // not flattened away.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.components).toHaveLength(2);

    // 期待2 (AC-2): the combined answer (both taps) travels all the way back
    // through the hook's deny envelope.
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("承認");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("低");
  });
});
