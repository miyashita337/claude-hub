// supervisor/src/bot-wiring.ts (Issue #383, Epic #381)
//
// The startup *wiring* of bot.ts — "which event gets which handler" — extracted
// out of startBot() as a declarative id list plus two pure application
// functions. Same shape as `infra/hook-wiring-check.ts` (#370): a required-
// wiring constant + a pure checker, so the contract is data a test can assert
// against instead of prose nobody verifies.
//
// Why this exists: a dropped or mis-targeted registration in startBot() only
// shows up on a live Discord Gateway, so CI waves it through (#381's analysis:
// 13% of these are caught before merge). #370 was exactly that failure —
// ask-user-relay.sh POSTed to an endpoint whose subscriber was never wired, and
// the question silently never left the TUI for ~5 months. Routing every
// registration through a surface makes the wiring observable in-process:
// `RecordingWiringSurface` captures what a real startup would register, and
// `createDiscordWiringSurface` is the single place that maps an id onto its
// real target (client event / relay subscriber / signal).
//
// Deliberately NOT moved here: the handler bodies. They stay in bot.ts closing
// over startBot's collaborators. This module owns the *map*, not the behaviour.

import { Events, type Client, type Interaction, type Message } from "discord.js";
import type * as RelayServer from "./session/relay-server";

// ---------------------------------------------------------------------------
// Wiring identifiers
// ---------------------------------------------------------------------------

/**
 * Registrations made once, before `client.login()`. Order within this list is
 * the order they are applied; it is not behaviourally significant (each id is a
 * distinct event with a single handler) but keeping it stable makes the test
 * snapshot readable.
 */
export const BOOT_WIRING_IDS = [
  "sessionManager:sessionEnd",
  "client:ClientReady",
  "client:InteractionCreate",
  "client:MessageCreate",
  "process:SIGTERM",
  "process:SIGINT",
] as const;

/**
 * Relay-server subscribers registered *after* the Gateway is ready. They must
 * not be hoisted to boot time: their handlers resolve Discord channels (and
 * `relay:hubWork` enumerates `readyClient.guilds.cache`), so a request arriving
 * before login would fail. The relay endpoints answer 503 / empty until wired,
 * which is the intended fail-closed window.
 */
export const READY_WIRING_IDS = [
  "relay:progress",
  "relay:sessionsQuery",
  "relay:askUser",
  // Issue #416: without this subscriber an expired ask is silent in Discord —
  // the thread keeps showing a question nobody is waiting on any more.
  "relay:askExpired",
  "relay:lateResponse",
  "relay:hubWork",
  "relay:channelPost",
] as const;

export type BootWiringId = (typeof BOOT_WIRING_IDS)[number];
export type ReadyWiringId = (typeof READY_WIRING_IDS)[number];
export type WiringId = BootWiringId | ReadyWiringId;

// ---------------------------------------------------------------------------
// Handler contracts
// ---------------------------------------------------------------------------

/**
 * Handlers bot.ts supplies for the boot-time wiring. Keyed by wiring id so the
 * call site reads as the wiring map itself, and a forgotten handler is a
 * compile error rather than a runtime hole.
 */
export interface BootWiringHandlers {
  "sessionManager:sessionEnd": (threadId: string) => void;
  "client:ClientReady": (readyClient: Client<true>) => void | Promise<void>;
  "client:InteractionCreate": (interaction: Interaction) => void;
  "client:MessageCreate": (message: Message) => void | Promise<void>;
  "process:SIGTERM": () => void | Promise<void>;
  "process:SIGINT": () => void | Promise<void>;
}

/**
 * Handlers for the ready-time relay subscribers. Types are derived from the
 * real `relay-server` registration functions, so a signature change there
 * surfaces here as a type error instead of a silently-mismatched callback.
 */
export interface ReadyWiringHandlers {
  "relay:progress": Parameters<typeof RelayServer.onProgress>[0];
  "relay:sessionsQuery": Parameters<typeof RelayServer.onSessionsQuery>[0];
  "relay:askUser": Parameters<typeof RelayServer.onAskUser>[0];
  "relay:askExpired": Parameters<typeof RelayServer.onAskExpired>[0];
  "relay:lateResponse": Parameters<typeof RelayServer.onLateResponse>[0];
  "relay:hubWork": Parameters<typeof RelayServer.onHubWork>[0];
  "relay:channelPost": Parameters<typeof RelayServer.onChannelPost>[0];
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/**
 * Sink every startup registration flows through. Handlers are `unknown` here on
 * purpose: the type-safe contract lives in {@link BootWiringHandlers} /
 * {@link ReadyWiringHandlers} at the call site, and narrowing again per id
 * would force this interface to enumerate them a second time.
 */
export interface BotWiringSurface {
  register(id: WiringId, handler: unknown): void;
}

/**
 * Applies the boot-time wiring. Callers own the handler bodies; this owns the
 * mapping of body → id.
 */
export function wireBoot(
  surface: BotWiringSurface,
  handlers: BootWiringHandlers,
): void {
  for (const id of BOOT_WIRING_IDS) surface.register(id, handlers[id]);
}

/** Applies the ready-time relay wiring. Call from inside the ClientReady handler. */
export function wireReady(
  surface: BotWiringSurface,
  handlers: ReadyWiringHandlers,
): void {
  for (const id of READY_WIRING_IDS) surface.register(id, handlers[id]);
}

// ---------------------------------------------------------------------------
// Real surface (id → live target)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the discord.js `Client` used for event registration.
 *
 * `any[]` on the listener is required, not laziness: discord.js types `on` /
 * `once` as generic overloads keyed on `keyof ClientEvents`, and a stricter
 * listener parameter (`never[]`) makes the real `Client` non-assignable to this
 * interface. The narrow types are recovered by the casts in
 * {@link createDiscordWiringSurface}, which the wiring test verifies by
 * asserting each id lands on the right event with the right handler.
 */
export interface WiringClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** The live objects a wiring id can be registered against. */
export interface WiringTargets {
  client: WiringClient;
  relay: {
    onProgress: typeof RelayServer.onProgress;
    onSessionsQuery: typeof RelayServer.onSessionsQuery;
    onAskUser: typeof RelayServer.onAskUser;
    onAskExpired: typeof RelayServer.onAskExpired;
    onLateResponse: typeof RelayServer.onLateResponse;
    onHubWork: typeof RelayServer.onHubWork;
    onChannelPost: typeof RelayServer.onChannelPost;
  };
  sessionManager: { onSessionEnd(listener: (threadId: string) => void): void };
  signals: { on(signal: NodeJS.Signals, listener: () => void): unknown };
}

/**
 * The one place a wiring id becomes a real registration. The switch is
 * exhaustive over {@link WiringId} (see the `never` default), so adding an id
 * without giving it a target is a compile error.
 */
export function createDiscordWiringSurface(
  targets: WiringTargets,
): BotWiringSurface {
  return {
    register(id, handler) {
      switch (id) {
        case "sessionManager:sessionEnd":
          targets.sessionManager.onSessionEnd(
            handler as BootWiringHandlers["sessionManager:sessionEnd"],
          );
          return;
        case "client:ClientReady":
          targets.client.once(
            Events.ClientReady,
            handler as BootWiringHandlers["client:ClientReady"],
          );
          return;
        case "client:InteractionCreate":
          targets.client.on(
            Events.InteractionCreate,
            handler as BootWiringHandlers["client:InteractionCreate"],
          );
          return;
        case "client:MessageCreate":
          targets.client.on(
            Events.MessageCreate,
            handler as BootWiringHandlers["client:MessageCreate"],
          );
          return;
        case "process:SIGTERM":
          targets.signals.on(
            "SIGTERM",
            handler as BootWiringHandlers["process:SIGTERM"],
          );
          return;
        case "process:SIGINT":
          targets.signals.on(
            "SIGINT",
            handler as BootWiringHandlers["process:SIGINT"],
          );
          return;
        case "relay:progress":
          targets.relay.onProgress(
            handler as ReadyWiringHandlers["relay:progress"],
          );
          return;
        case "relay:sessionsQuery":
          targets.relay.onSessionsQuery(
            handler as ReadyWiringHandlers["relay:sessionsQuery"],
          );
          return;
        case "relay:askUser":
          targets.relay.onAskUser(
            handler as ReadyWiringHandlers["relay:askUser"],
          );
          return;
        case "relay:askExpired":
          targets.relay.onAskExpired(
            handler as ReadyWiringHandlers["relay:askExpired"],
          );
          return;
        case "relay:lateResponse":
          targets.relay.onLateResponse(
            handler as ReadyWiringHandlers["relay:lateResponse"],
          );
          return;
        case "relay:hubWork":
          targets.relay.onHubWork(
            handler as ReadyWiringHandlers["relay:hubWork"],
          );
          return;
        case "relay:channelPost":
          targets.relay.onChannelPost(
            handler as ReadyWiringHandlers["relay:channelPost"],
          );
          return;
        default: {
          const unreachable: never = id;
          throw new Error(`[BotWiring] unmapped wiring id: ${String(unreachable)}`);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Recording surface + diff (test / introspection)
// ---------------------------------------------------------------------------

interface RecordedWiring {
  id: WiringId;
  handler: unknown;
}

/**
 * Captures registrations instead of performing them. Lets a test run the real
 * `wireBoot` / `wireReady` and assert the resulting wiring set exactly, so both
 * a missing and a duplicated registration fail.
 */
export class RecordingWiringSurface implements BotWiringSurface {
  private readonly recorded: RecordedWiring[] = [];

  register(id: WiringId, handler: unknown): void {
    this.recorded.push({ id, handler });
  }

  /** Registered ids in registration order (duplicates preserved). */
  ids(): WiringId[] {
    return this.recorded.map((r) => r.id);
  }

  /** Handlers registered for an id. Length > 1 means a duplicate registration. */
  handlersFor(id: WiringId): unknown[] {
    return this.recorded.filter((r) => r.id === id).map((r) => r.handler);
  }
}

export interface WiringDiff {
  /** Expected but never registered — the #370 failure mode. */
  missing: WiringId[];
  /** Registered but not part of the expected contract. */
  unexpected: WiringId[];
  /** Registered more than once (a second handler silently replaces the first). */
  duplicated: WiringId[];
}

/**
 * Pure comparison of an actual registration list against the expected contract.
 * Exported separately from the surface so the matching logic is testable on
 * fixtures, mirroring `findMissingHookWiring` (#370).
 */
export function diffWiring(
  actual: readonly WiringId[],
  expected: readonly WiringId[],
): WiringDiff {
  const counts = new Map<WiringId, number>();
  for (const id of actual) counts.set(id, (counts.get(id) ?? 0) + 1);

  return {
    missing: expected.filter((id) => !counts.has(id)),
    unexpected: [...counts.keys()].filter((id) => !expected.includes(id)),
    duplicated: [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([id]) => id),
  };
}

/** True when the wiring matches the contract exactly. */
export function isWiringComplete(diff: WiringDiff): boolean {
  return (
    diff.missing.length === 0 &&
    diff.unexpected.length === 0 &&
    diff.duplicated.length === 0
  );
}
