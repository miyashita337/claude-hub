// Issue #383 (Epic #381): startup wiring verification for bot.ts.
//
// The bug class: a registration in startBot() that is dropped, duplicated, or
// pointed at the wrong event only fails against a live Discord Gateway, so CI
// waves it through. #370 is the reference incident — a relay subscriber that
// existed but was never wired, silent for ~5 months.
//
// These tests replay the *real* wiring functions (wireBoot / wireReady) against
// in-memory targets and assert the resulting registration set exactly, so both
// a missing and an extra/duplicate wiring fail. The id → target mapping in
// createDiscordWiringSurface is exercised too: a handler landing on the wrong
// client event or relay subscriber fails here rather than in production.
//
// Note on the client double: bot.ts drives the raw discord.js Client (on/once),
// not the IDiscordClient relay abstraction that src/discord/in-memory-client.ts
// fakes. So this file uses its own in-memory client covering the surface bot.ts
// actually registers against; conflating the two abstractions would make
// InMemoryDiscordClient serve two unrelated roles.

import { test, expect, describe } from "bun:test";
import { Events } from "discord.js";
import {
  BOOT_WIRING_IDS,
  READY_WIRING_IDS,
  RecordingWiringSurface,
  createDiscordWiringSurface,
  diffWiring,
  isWiringComplete,
  wireBoot,
  wireReady,
  type BootWiringHandlers,
  type BootWiringId,
  type ReadyWiringHandlers,
  type ReadyWiringId,
  type WiringId,
} from "../../src/bot-wiring";

// --- in-memory doubles -----------------------------------------------------

interface Registration {
  event: string;
  once: boolean;
  handler: unknown;
}

/** In-memory stand-in for the discord.js Client's event registration surface. */
class InMemoryWiringClient {
  readonly registrations: Registration[] = [];

  once(event: string, handler: (...args: never[]) => void): unknown {
    this.registrations.push({ event, once: true, handler });
    return this;
  }

  on(event: string, handler: (...args: never[]) => void): unknown {
    this.registrations.push({ event, once: false, handler });
    return this;
  }

  find(event: string): Registration | undefined {
    return this.registrations.find((r) => r.event === event);
  }
}

/**
 * Records which relay subscriber received which handler. Signatures are
 * intentionally loose (the surface casts); identity is what these tests assert.
 */
function makeRelayTargets() {
  const seen = new Map<string, unknown[]>();
  const capture =
    (name: string) =>
    (handler: unknown): void => {
      seen.set(name, [...(seen.get(name) ?? []), handler]);
    };
  return {
    seen,
    targets: {
      onProgress: capture("onProgress"),
      onSessionsQuery: capture("onSessionsQuery"),
      onAskUser: capture("onAskUser"),
      onLateResponse: capture("onLateResponse"),
      onHubWork: capture("onHubWork"),
      onChannelPost: capture("onChannelPost"),
    } as unknown as Parameters<typeof createDiscordWiringSurface>[0]["relay"],
  };
}

/** Sentinel handlers: distinct objects so cross-wiring is detectable by identity. */
function makeBootHandlers(): BootWiringHandlers {
  return {
    "sessionManager:sessionEnd": () => {},
    "client:ClientReady": async () => {},
    "client:InteractionCreate": () => {},
    "client:MessageCreate": async () => {},
    "process:SIGTERM": async () => {},
    // A *distinct* function from SIGTERM here even though bot.ts shares one
    // `shutdown` — sharing is fine in production, but distinct sentinels are
    // what let this test detect one signal being wired to the other's handler.
    "process:SIGINT": async () => {},
  };
}

function makeReadyHandlers(): ReadyWiringHandlers {
  return {
    "relay:progress": () => {},
    "relay:sessionsQuery": () => [],
    "relay:askUser": () => {},
    "relay:lateResponse": () => {},
    "relay:hubWork": async () => ({
      ok: true as const,
      threadId: "t",
      queued: false,
      injected: "",
    }),
    "relay:channelPost": async () => ({
      ok: true as const,
      channelId: "c",
      chunks: 1,
    }),
  };
}

function makeSurfaceUnderTest() {
  const client = new InMemoryWiringClient();
  const relay = makeRelayTargets();
  const sessionEndHandlers: unknown[] = [];
  const signalHandlers: Array<{ signal: string; handler: unknown }> = [];
  const surface = createDiscordWiringSurface({
    client,
    relay: relay.targets,
    sessionManager: {
      onSessionEnd: (h) => {
        sessionEndHandlers.push(h);
      },
    },
    signals: {
      on: (signal, handler) => {
        signalHandlers.push({ signal, handler });
        return undefined;
      },
    },
  });
  return { surface, client, relay, sessionEndHandlers, signalHandlers };
}

// --- the reviewed contract -------------------------------------------------

/**
 * Hand-written expectation, deliberately NOT derived from BOOT_WIRING_IDS /
 * READY_WIRING_IDS. Asserting the constants against themselves would pass even
 * if an id were deleted from the constant (the applied list shrinks with it) —
 * exactly the mutation this suite has to catch. Changing the supervisor's
 * startup wiring must therefore be a two-sided, reviewed edit.
 */
const EXPECTED_BOOT_WIRING: BootWiringId[] = [
  "sessionManager:sessionEnd",
  "client:ClientReady",
  "client:InteractionCreate",
  "client:MessageCreate",
  "process:SIGTERM",
  "process:SIGINT",
];

const EXPECTED_READY_WIRING: ReadyWiringId[] = [
  "relay:progress",
  "relay:sessionsQuery",
  "relay:askUser",
  "relay:lateResponse",
  "relay:hubWork",
  "relay:channelPost",
];

// --- wiring completeness ---------------------------------------------------

describe("startup wiring is complete (#383)", () => {
  test("the exported contracts match the reviewed wiring list", () => {
    expect([...BOOT_WIRING_IDS]).toEqual(EXPECTED_BOOT_WIRING);
    expect([...READY_WIRING_IDS]).toEqual(EXPECTED_READY_WIRING);
  });

  test("wireBoot registers exactly the boot-time contract", () => {
    const recorder = new RecordingWiringSurface();
    wireBoot(recorder, makeBootHandlers());

    // Exact array equality: a dropped id, an extra id, and a re-ordered list
    // all fail. Registration order is asserted so the snapshot stays readable.
    expect(recorder.ids()).toEqual(EXPECTED_BOOT_WIRING);

    const diff = diffWiring(recorder.ids(), EXPECTED_BOOT_WIRING);
    expect(diff).toEqual({ missing: [], unexpected: [], duplicated: [] });
    expect(isWiringComplete(diff)).toBe(true);
  });

  test("wireReady registers exactly the ready-time contract", () => {
    const recorder = new RecordingWiringSurface();
    wireReady(recorder, makeReadyHandlers());

    expect(recorder.ids()).toEqual(EXPECTED_READY_WIRING);
    expect(diffWiring(recorder.ids(), EXPECTED_READY_WIRING)).toEqual({
      missing: [],
      unexpected: [],
      duplicated: [],
    });
  });

  test("each id receives its own handler (no cross-wiring, no duplicates)", () => {
    const recorder = new RecordingWiringSurface();
    const boot = makeBootHandlers();
    const ready = makeReadyHandlers();
    wireBoot(recorder, boot);
    wireReady(recorder, ready);

    for (const id of BOOT_WIRING_IDS) {
      expect(recorder.handlersFor(id)).toEqual([boot[id]]);
    }
    for (const id of READY_WIRING_IDS) {
      expect(recorder.handlersFor(id)).toEqual([ready[id]]);
    }
  });

  test("boot and ready contracts are disjoint", () => {
    const overlap = (BOOT_WIRING_IDS as readonly string[]).filter((id) =>
      (READY_WIRING_IDS as readonly string[]).includes(id),
    );
    expect(overlap).toEqual([]);
  });
});

// --- id → real target mapping ---------------------------------------------

describe("wiring surface targets the right sink (#383)", () => {
  test("client events land on the right discord.js event with the right mode", () => {
    const { surface, client } = makeSurfaceUnderTest();
    const boot = makeBootHandlers();
    wireBoot(surface, boot);

    // ClientReady must be `once` (re-running boot setup on every reconnect
    // would re-register slash commands and restart the reapers).
    expect(client.find(Events.ClientReady)).toEqual({
      event: Events.ClientReady,
      once: true,
      handler: boot["client:ClientReady"],
    });
    expect(client.find(Events.InteractionCreate)).toEqual({
      event: Events.InteractionCreate,
      once: false,
      handler: boot["client:InteractionCreate"],
    });
    expect(client.find(Events.MessageCreate)).toEqual({
      event: Events.MessageCreate,
      once: false,
      handler: boot["client:MessageCreate"],
    });
    // Nothing else was registered on the client.
    expect(client.registrations).toHaveLength(3);
  });

  test("session-end and both termination signals are wired", () => {
    const { surface, sessionEndHandlers, signalHandlers } = makeSurfaceUnderTest();
    const boot = makeBootHandlers();
    wireBoot(surface, boot);

    expect(sessionEndHandlers).toEqual([boot["sessionManager:sessionEnd"]]);
    // SIGTERM (launchd stop) and SIGINT (Ctrl-C) both need the graceful path —
    // losing either leaks tmux sessions on shutdown.
    expect(signalHandlers).toEqual([
      { signal: "SIGTERM", handler: boot["process:SIGTERM"] },
      { signal: "SIGINT", handler: boot["process:SIGINT"] },
    ]);
  });

  test("every relay subscriber receives exactly its own handler", () => {
    const { surface, relay } = makeSurfaceUnderTest();
    const ready = makeReadyHandlers();
    wireReady(surface, ready);

    expect(Object.fromEntries(relay.seen)).toEqual({
      onProgress: [ready["relay:progress"]],
      onSessionsQuery: [ready["relay:sessionsQuery"]],
      onAskUser: [ready["relay:askUser"]],
      onLateResponse: [ready["relay:lateResponse"]],
      // #370's regression: this subscriber going missing left AskUserQuestion
      // stranded in the TUI. onHubWork / onChannelPost fail-close to 503, which
      // is quieter still.
      onHubWork: [ready["relay:hubWork"]],
      onChannelPost: [ready["relay:channelPost"]],
    });
  });

  test("boot wiring touches no relay subscriber (and vice versa)", () => {
    const boot = makeSurfaceUnderTest();
    wireBoot(boot.surface, makeBootHandlers());
    expect(boot.relay.seen.size).toBe(0);

    const ready = makeSurfaceUnderTest();
    wireReady(ready.surface, makeReadyHandlers());
    expect(ready.client.registrations).toHaveLength(0);
    expect(ready.signalHandlers).toHaveLength(0);
    expect(ready.sessionEndHandlers).toHaveLength(0);
  });

  test("an unmapped id throws instead of silently no-op-ing", () => {
    const { surface } = makeSurfaceUnderTest();
    expect(() =>
      surface.register("relay:doesNotExist" as WiringId, () => {}),
    ).toThrow(/unmapped wiring id/);
  });
});

// --- bot.ts routes every registration through the surface ------------------

describe("bot.ts does not bypass the wiring surface (#383)", () => {
  // The contract above only covers registrations that go through the surface.
  // A `client.on(...)` added straight into startBot() would be invisible to it,
  // which puts us back at the #370 failure mode. Source-level guard, same shape
  // as tests/guards/access-enforcement-wired.test.ts.
  const BYPASS_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /\bclient\.(on|once)\s*\(/, why: "use wireBoot() with a client:* id" },
    { pattern: /\bprocess\.on\s*\(/, why: "use wireBoot() with a process:* id" },
    {
      pattern: /\bsessionManager\.onSessionEnd\s*\(/,
      why: "use wireBoot() with sessionManager:sessionEnd",
    },
    {
      pattern: /\bon(Progress|SessionsQuery|AskUser|LateResponse|HubWork|ChannelPost)\s*\(/,
      why: "use wireReady() with the matching relay:* id",
    },
  ];

  test("startBot registers only via wireBoot / wireReady", async () => {
    const src = await Bun.file("src/bot.ts").text();

    for (const { pattern, why } of BYPASS_PATTERNS) {
      const offenders = src
        .split("\n")
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter(({ line }) => pattern.test(line) && !line.startsWith("//"));
      expect({ pattern: String(pattern), offenders, why }).toEqual({
        pattern: String(pattern),
        offenders: [],
        why,
      });
    }

    // ...and it does apply both halves of the contract.
    expect(src).toContain("wireBoot(wiringSurface");
    expect(src).toContain("wireReady(wiringSurface");
  });
});

// --- diff logic ------------------------------------------------------------

describe("diffWiring (#383)", () => {
  test("reports a dropped registration", () => {
    const actual = BOOT_WIRING_IDS.filter((id) => id !== "client:MessageCreate");
    const diff = diffWiring(actual, BOOT_WIRING_IDS);
    expect(diff.missing).toEqual(["client:MessageCreate"]);
    expect(isWiringComplete(diff)).toBe(false);
  });

  test("reports a duplicated registration", () => {
    const actual: WiringId[] = [...BOOT_WIRING_IDS, "client:MessageCreate"];
    const diff = diffWiring(actual, BOOT_WIRING_IDS);
    // A second registration on the same relay slot silently replaces the first,
    // so duplicates are a defect even though nothing is "missing".
    expect(diff.duplicated).toEqual(["client:MessageCreate"]);
    expect(diff.missing).toEqual([]);
    expect(isWiringComplete(diff)).toBe(false);
  });

  test("reports an unexpected registration", () => {
    const diff = diffWiring(
      [...BOOT_WIRING_IDS, "relay:progress"],
      BOOT_WIRING_IDS,
    );
    expect(diff.unexpected).toEqual(["relay:progress"]);
    expect(isWiringComplete(diff)).toBe(false);
  });

  test("empty actual reports every expected id as missing", () => {
    const diff = diffWiring([], READY_WIRING_IDS);
    expect(diff.missing).toEqual([...READY_WIRING_IDS]);
  });
});
