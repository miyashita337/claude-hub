import { describe, test, expect } from "bun:test";
import {
  UnregisteredTmuxWatch,
  formatUnregisteredTmuxAlert,
  type UnregisteredTmuxSighting,
} from "../../src/session/unregistered-tmux-watch";
import { SESSION_IDLE_DEFAULT_MS } from "../../src/config/channels";

/**
 * Issue #435: the idle reaper only walks SessionManager-registered sessions, so a
 * tmux session on the supervisor socket that the supervisor never registered is
 * invisible forever. Policy (issue comment): detect + notify once, never kill.
 */

const HOUR = 60 * 60 * 1000;

function harness(opts: { names: string[]; thresholdMs?: number; failNotify?: boolean }) {
  let clock = 0;
  const state = { names: opts.names };
  const notified: UnregisteredTmuxSighting[][] = [];
  const watch = new UnregisteredTmuxWatch({
    listUnregistered: async () => state.names,
    notify: async (sightings) => {
      if (opts.failNotify) throw new Error("discord down");
      notified.push(sightings);
    },
    thresholdMs: opts.thresholdMs ?? 6 * HOUR,
    now: () => clock,
  });
  return {
    watch,
    notified,
    state,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("UnregisteredTmuxWatch (#435)", () => {
  test("defaults the threshold to the idle-reaper default (6h)", () => {
    const w = new UnregisteredTmuxWatch({
      listUnregistered: async () => [],
      notify: async () => {},
    });
    expect(w.thresholdMs).toBe(SESSION_IDLE_DEFAULT_MS);
  });

  test("AC-1: an unregistered session observed past the threshold is notified", async () => {
    const h = harness({ names: ["claude-x"] });
    expect(await h.watch.scan()).toEqual([]); // first sighting only records
    h.advance(6 * HOUR + 1);
    expect(await h.watch.scan()).toEqual(["claude-x"]);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]![0]!.name).toBe("claude-x");
    expect(h.notified[0]![0]!.observedMs).toBe(6 * HOUR + 1);
  });

  test("does not notify before the threshold", async () => {
    const h = harness({ names: ["claude-x"] });
    await h.watch.scan();
    h.advance(6 * HOUR - 1);
    expect(await h.watch.scan()).toEqual([]);
    expect(h.notified).toHaveLength(0);
  });

  test("idempotent: the same session is notified only once", async () => {
    const h = harness({ names: ["claude-x"] });
    await h.watch.scan();
    h.advance(7 * HOUR);
    await h.watch.scan();
    h.advance(7 * HOUR);
    expect(await h.watch.scan()).toEqual([]);
    expect(h.notified).toHaveLength(1);
  });

  test("several due sessions are batched into one notification", async () => {
    const h = harness({ names: ["claude-x", "claude-tricky"] });
    await h.watch.scan();
    h.advance(7 * HOUR);
    await h.watch.scan();
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]!.map((s) => s.name).sort()).toEqual([
      "claude-tricky",
      "claude-x",
    ]);
  });

  test("a session that disappears is forgotten; a same-named re-creation is a new episode", async () => {
    const h = harness({ names: ["claude-x", "keep"] });
    await h.watch.scan();
    h.advance(7 * HOUR);
    await h.watch.scan(); // both notified
    h.state.names = ["keep"];
    await h.watch.scan(); // claude-x gone → forgotten
    expect(h.watch.isNotified("claude-x")).toBe(false);
    h.state.names = ["claude-x", "keep"];
    await h.watch.scan(); // new first sighting
    h.advance(1 * HOUR);
    expect(await h.watch.scan()).toEqual([]); // not yet due again
    h.advance(6 * HOUR);
    expect(await h.watch.scan()).toEqual(["claude-x"]);
    expect(h.notified).toHaveLength(2);
  });

  test("an empty listing (indistinguishable from a tmux failure) changes no state — no re-page", async () => {
    const h = harness({ names: ["claude-x"] });
    await h.watch.scan();
    h.advance(7 * HOUR);
    await h.watch.scan(); // notified
    h.state.names = []; // tmux list-sessions failed → []
    await h.watch.scan();
    h.state.names = ["claude-x"];
    h.advance(7 * HOUR);
    expect(await h.watch.scan()).toEqual([]);
    expect(h.notified).toHaveLength(1);
  });

  test("AC-2: a session that becomes registered (drops out of the list) is never notified", async () => {
    const h = harness({ names: ["claude-abc", "other"] });
    await h.watch.scan();
    h.state.names = ["other"]; // supervisor registered claude-abc
    h.advance(7 * HOUR);
    expect(await h.watch.scan()).toEqual(["other"]);
    expect(h.notified.flat().map((s) => s.name)).not.toContain("claude-abc");
  });

  test("a failed notification is retried on the next scan (not marked as sent)", async () => {
    const h = harness({ names: ["claude-x"], failNotify: true });
    await h.watch.scan();
    h.advance(7 * HOUR);
    expect(await h.watch.scan()).toEqual([]);
    expect(h.watch.isNotified("claude-x")).toBe(false);
  });
});

describe("formatUnregisteredTmuxAlert (#435)", () => {
  test("names each session, says it will not be killed, and gives the manual check command", () => {
    const text = formatUnregisteredTmuxAlert([
      { name: "claude-x", observedMs: 6.5 * HOUR },
    ]);
    expect(text).toContain("claude-x");
    expect(text).toContain("6.5h");
    expect(text).toContain("自動回収はしません");
    expect(text).toContain("tmux -L claude-hub ls");
    expect(text).toContain("#435");
  });
});
