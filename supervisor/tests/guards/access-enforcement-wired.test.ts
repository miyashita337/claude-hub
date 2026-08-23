import { test, expect, describe } from "bun:test";

/**
 * Issue #32 / S7 (Critical): guard that the runtime access enforcement stays
 * wired at all three relay entry points. Behavioral coverage lives in
 * tests/config/access-policy.test.ts, tests/discord/real-client.test.ts, and
 * tests/commands/session-start-access.test.ts; this guard prevents a future
 * refactor from silently deleting or reordering the gate so the gate is never
 * bypassed (defense-in-depth against the lateral-movement regression).
 */

async function read(path: string): Promise<string> {
  return Bun.file(path).text();
}

describe("access enforcement is wired (#32 / S7)", () => {
  test("bot.ts evaluates access before relaying (sendMessage)", async () => {
    const src = await read("src/bot.ts");
    expect(src).toContain("evaluateAccess");
    const gateIdx = src.indexOf("evaluateAccess");
    const relayIdx = src.indexOf("sessionManager.sendMessage");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(relayIdx).toBeGreaterThan(-1);
    // The gate must appear before the relay call so a denied message never
    // reaches the session.
    expect(gateIdx).toBeLessThan(relayIdx);
    // Fail-closed: a denied decision returns without relaying.
    expect(src).toContain("decision.allowed");
  });

  test("real-client.ts evaluates access before dispatching thread handlers", async () => {
    const src = await read("src/discord/real-client.ts");
    expect(src).toContain("evaluateAccess");
    const gateIdx = src.indexOf("evaluateAccess");
    const dispatchIdx = src.indexOf("for (const h of this.threadHandlers)");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(dispatchIdx);
  });

  test("session.ts handleStart evaluates access before starting a session", async () => {
    const src = await read("src/commands/session.ts");
    expect(src).toContain("evaluateAccess");
    const gateIdx = src.indexOf("evaluateAccess");
    const startIdx = src.indexOf("sessionManager.start(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(startIdx);
  });

  test("denial logs do not interpolate raw user/channel ids", async () => {
    // The structured denial logs must reference the coarse `decision.reason`
    // enum and thread id, never the sender/channel snowflake or message body.
    for (const path of [
      "src/bot.ts",
      "src/discord/real-client.ts",
      "src/commands/session.ts",
    ]) {
      const src = await read(path);
      const denialLines = src
        .split("\n")
        .filter((l) => /Access denied|access denied/.test(l));
      expect(denialLines.length).toBeGreaterThan(0);
      for (const line of denialLines) {
        // Must log the reason enum.
        expect(line).toContain("reason=");
        // Must NOT log the sender id or message body.
        expect(line).not.toContain("message.author.id");
        expect(line).not.toContain("interaction.user.id");
        expect(line).not.toContain("message.content");
      }
    }
  });
});

describe("dispatch transport is wired fail-closed (#32 / S7)", () => {
  test("bot.ts intercepts dispatch BEFORE the bot/webhook drop", async () => {
    const src = await read("src/bot.ts");
    // The dispatch interception must run before the `message.author.bot` drop,
    // otherwise an external source (a bot/webhook) can never trigger it.
    const dispatchIdx = src.indexOf("handleDispatchMessage(message)");
    const botDropIdx = src.indexOf("if (message.author.bot) return;");
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(botDropIdx).toBeGreaterThan(-1);
    // The call inside the MessageCreate handler precedes the bot drop.
    expect(dispatchIdx).toBeLessThan(botDropIdx);
  });

  test("bot.ts authorizes the source before parsing/starting (fail-closed)", async () => {
    const src = await read("src/bot.ts");
    expect(src).toContain("isDispatchSourceAllowed");
    const authIdx = src.indexOf("isDispatchSourceAllowed");
    const parseIdx = src.indexOf("parseDispatchCommand(content)");
    const runIdx = src.indexOf("runDispatch(");
    expect(authIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(-1);
    // Source authorization must precede both parsing and the actual start.
    expect(authIdx).toBeLessThan(parseIdx);
    expect(authIdx).toBeLessThan(runIdx);
    // A denied decision must not proceed to runDispatch.
    expect(src).toContain("decision.allowed");
  });

  test("dispatch denial logs do not interpolate raw source/channel ids or body", async () => {
    const src = await read("src/bot.ts");
    const denialLines = src
      .split("\n")
      .filter((l) => /Dispatch denied|Dispatch rejected/.test(l));
    expect(denialLines.length).toBeGreaterThan(0);
    for (const line of denialLines) {
      expect(line).not.toContain("message.author.id");
      expect(line).not.toContain("message.content");
    }
  });
});

/**
 * Issue #426: the brief trigger is the SECOND exception to the blanket
 * bot/webhook drop, and it injects instructions into the already-running HQ
 * session. Behavioral coverage (fail-closed authorization, closed date token,
 * target resolution) lives in tests/session/corp-brief.test.ts; this guard fixes
 * the wiring so a refactor cannot move the interception after the drop (making
 * it dead) or move the authorization after the injection (making it bypassable).
 */
describe("brief trigger is wired fail-closed (#426)", () => {
  test("bot.ts intercepts brief BEFORE the bot/webhook drop", async () => {
    const src = await read("src/bot.ts");
    const briefIdx = src.indexOf("handleBriefMessage(message)");
    const botDropIdx = src.indexOf("if (message.author.bot) return;");
    expect(briefIdx).toBeGreaterThan(-1);
    expect(botDropIdx).toBeGreaterThan(-1);
    expect(briefIdx).toBeLessThan(botDropIdx);
  });

  test("the brief evaluator authorizes with the dispatch gate, before parsing", async () => {
    const src = await read("src/session/corp-brief.ts");
    // Reuses the existing dispatch-source gate rather than inventing a second
    // authorization model.
    expect(src).toContain("isDispatchSourceAllowed");
    // `isDispatchSourceAllowed(` (with the paren) matches only the call site —
    // the import lists the bare identifier — so this compares real positions.
    const authIdx = src.indexOf("isDispatchSourceAllowed(");
    const parseIdx = src.indexOf("parseBriefCommand(input.content)");
    expect(authIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(-1);
    // An unauthorized source's message must not be interpreted at all.
    expect(authIdx).toBeLessThan(parseIdx);
    expect(src).toContain("decision.allowed");
  });

  test("bot.ts runs the proposals CLI only after the evaluator's decide verdict (#449)", async () => {
    const src = await read("src/bot.ts");
    const evalIdx = src.indexOf("evaluateBriefTrigger({");
    // `config.brief.proposalsArgs` is consumed only inside the `decide` case,
    // so its position after the evaluator pins the order: no CLI execution
    // before the fail-closed authorization verdict.
    const cliIdx = src.indexOf("config.brief.proposalsArgs");
    expect(evalIdx).toBeGreaterThan(-1);
    expect(cliIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeLessThan(cliIdx);
  });

  test("the brief path no longer types into any session (#449: session-less by design)", async () => {
    // #426's injection capability (typing into an already-running session,
    // Escape first) was the reason the path needed the ask guard / no_session /
    // ambiguous safety valves. #449 removed the capability itself: the brief
    // path must build tap-to-decide buttons, never a session injection. A
    // refactor that reintroduces an injected sentence would bring back the
    // whole failure class — pin its absence.
    const brief = await read("src/session/corp-brief.ts");
    expect(brief).not.toContain("buildBriefInjection");
    const src = await read("src/bot.ts");
    expect(src).toContain("runBriefDecideFlow(");
  });

  test("brief denial logs do not interpolate raw source/channel ids or body", async () => {
    const src = await read("src/bot.ts");
    const denialLines = src
      .split("\n")
      .filter((l) => /Brief denied|Brief rejected/.test(l));
    expect(denialLines.length).toBeGreaterThan(0);
    for (const line of denialLines) {
      expect(line).not.toContain("message.author.id");
      expect(line).not.toContain("message.content");
    }
  });
});

/**
 * Issue #429 (PR #434 review, question-1). The behavioural half lives in
 * dispatch-integration.test.ts; this guard pins the bot.ts WIRING, because the
 * defect being fixed was precisely a wiring gap: the `!result.ok` arm existed
 * but only ever called `console.error`, so a dispatch that never reached the
 * pane was invisible to the thread and to corp. A refactor that quietly returns
 * to log-only would restore the silent stall while every unit test still
 * passed — this catches that, in the same way the access gates above are
 * pinned against silent removal.
 */
describe("dispatch failure reaches the thread, not just the log (#429)", () => {
  test("bot.ts posts a failure notice on the !result.ok arm", async () => {
    const src = await read("src/bot.ts");
    // The notice builder is used (not a bare log, and not an ad-hoc string that
    // could leak the raw tmux cause).
    expect(src).toContain("buildDispatchFailureNotice");
    // ...and it is handed to the thread poster.
    const noticeIdx = src.indexOf("buildDispatchFailureNotice(");
    const postIdx = src.lastIndexOf("postToThread(", noticeIdx);
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(-1);
    // The post call opens immediately before the notice it sends.
    expect(postIdx).toBeLessThan(noticeIdx);
  });

  test("the failure notice is built inside the dispatch failure branch", async () => {
    const src = await read("src/bot.ts");
    const failureIdx = src.indexOf("Dispatch failed (stage=");
    const noticeIdx = src.indexOf("buildDispatchFailureNotice(");
    expect(failureIdx).toBeGreaterThan(-1);
    // The notice follows the failure log, i.e. it lives in the same arm rather
    // than somewhere that could fire on a success.
    expect(noticeIdx).toBeGreaterThan(failureIdx);
  });

  test("the raw cause cannot reach the thread through the notice", async () => {
    // Same contract as SEND_FAILURE_USER_MESSAGE (#74): tmux internals and
    // absolute paths stay in the Supervisor log. Enforced structurally — the
    // builder takes no error/cause parameter at all — so this checks the shape
    // rather than the wording (the wording itself is asserted behaviourally in
    // dispatch-run.test.ts).
    const src = await read("src/session/dispatch.ts");
    const sigIdx = src.indexOf("export function buildDispatchFailureNotice(");
    expect(sigIdx).toBeGreaterThan(-1);
    const params = src.slice(sigIdx, src.indexOf("): string {", sigIdx));
    expect(params).not.toMatch(/error|cause|err\b/i);

    // And the call site passes no error either.
    const bot = await read("src/bot.ts");
    const callIdx = bot.indexOf("buildDispatchFailureNotice(");
    expect(callIdx).toBeGreaterThan(-1);
    expect(bot.slice(callIdx, callIdx + 400)).not.toContain("result.error");
  });
});
