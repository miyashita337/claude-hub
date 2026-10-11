import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  resolveLauncher,
  splitLauncher,
  shellQuote,
  parseProxyBanner,
  stripProxyBanner,
  parseProcTable,
  findClaudeDescendant,
  sumTreeRssKB,
  waitForClaudePid,
  ALL_ORGS_EXHAUSTED_MARKER,
  type ProcRow,
} from "../../src/session/launcher";
import { detectDialog } from "../../src/session/dialog-detect";
import { SessionManager } from "../../src/session/manager";
import {
  createFakeEffects,
  type FakeSessionEffects,
} from "../../src/session/adapters-fake";
import type { ChannelConfig } from "../../src/config/channels";

/**
 * Issue #492: external claude launcher (`ccorg proxy`). Pure helpers + the
 * manager wiring on the DI fakes. Real-process behaviour (pid resolution, tree
 * RSS, orphan-free stop) is in launcher-real-process.test.ts.
 */

const BANNER =
  "-> proxy 127.0.0.1:50171 (order: personal, strategy: order, log: /var/folders/x/claude-org-proxy-AbC/proxy.log)";

describe("resolveLauncher (AC-1: unset => off)", () => {
  const ctx = { channelName: "dev-tool", headless: false };

  test("unset or blank launcher is null regardless of scope", () => {
    expect(resolveLauncher(ctx, {})).toBeNull();
    expect(
      resolveLauncher(ctx, {
        SUPERVISOR_CLAUDE_LAUNCHER: "  ",
        SUPERVISOR_CLAUDE_LAUNCHER_SCOPE: "all",
      }),
    ).toBeNull();
  });

  test("launcher without scope applies to everything, split on whitespace", () => {
    const env = { SUPERVISOR_CLAUDE_LAUNCHER: "ccorg proxy" };
    expect(resolveLauncher(ctx, env)).toEqual(["ccorg", "proxy"]);
    expect(resolveLauncher({ ...ctx, headless: true }, env)).toEqual([
      "ccorg",
      "proxy",
    ]);
  });

  test("scope gates by channel and by dispatch", () => {
    const env = (scope: string) => ({
      SUPERVISOR_CLAUDE_LAUNCHER: "ccorg proxy",
      SUPERVISOR_CLAUDE_LAUNCHER_SCOPE: scope,
    });
    expect(resolveLauncher(ctx, env("channel:dev-tool"))).not.toBeNull();
    expect(resolveLauncher(ctx, env("channel:other"))).toBeNull();
    expect(resolveLauncher(ctx, env("dispatch"))).toBeNull();
    expect(
      resolveLauncher({ ...ctx, headless: true }, env("dispatch")),
    ).not.toBeNull();
    expect(
      resolveLauncher(ctx, env("dispatch, channel:dev-tool")),
    ).not.toBeNull();
  });
});

describe("splitLauncher (AC-3: quoted paths stay one word)", () => {
  test("plain words split on whitespace", () => {
    expect(splitLauncher("ccorg  proxy")).toEqual(["ccorg", "proxy"]);
  });

  test("double / single quotes and backslash keep a spaced path as one word", () => {
    expect(splitLauncher('"/Users/Test User/bin/ccorg" proxy')).toEqual([
      "/Users/Test User/bin/ccorg",
      "proxy",
    ]);
    expect(splitLauncher("'/a b/ccorg' proxy")).toEqual(["/a b/ccorg", "proxy"]);
    expect(splitLauncher("/a\\ b/ccorg proxy")).toEqual(["/a b/ccorg", "proxy"]);
    expect(splitLauncher('"" x')).toEqual(["", "x"]);
  });

  test("unterminated quote is rejected loudly", () => {
    expect(() => splitLauncher('"/a b/ccorg proxy')).toThrow("引用符");
  });

  test("resolveLauncher uses it", () => {
    expect(
      resolveLauncher(
        { channelName: "c", headless: false },
        { SUPERVISOR_CLAUDE_LAUNCHER: '"/x y/ccorg" proxy' },
      ),
    ).toEqual(["/x y/ccorg", "proxy"]);
  });
});

describe("shellQuote", () => {
  test("neutralises quotes and metacharacters", () => {
    expect(shellQuote("ccorg")).toBe("'ccorg'");
    expect(shellQuote("a b;$(x)")).toBe("'a b;$(x)'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("proxy banner", () => {
  test("parses port and log path", () => {
    expect(parseProxyBanner(`noise\n${BANNER}\nmore`)).toEqual({
      port: 50171,
      logPath: "/var/folders/x/claude-org-proxy-AbC/proxy.log",
    });
  });

  test("returns null without a banner", () => {
    expect(parseProxyBanner("error: something failed")).toBeNull();
  });

  test("stripProxyBanner removes only the banner line", () => {
    expect(stripProxyBanner(`${BANNER}\nreal error\n`)).toBe("real error\n");
    expect(stripProxyBanner("real error")).toBe("real error");
  });
});

describe("process table helpers", () => {
  const ps = [
    "  100     1  50000 /sbin/launchd",
    "  200   100  60000 /opt/homebrew/bin/node",
    "  300   200 400000 /Users/u/.local/bin/claude",
    "  310   300  10000 /bin/zsh",
    "  400   100  70000 /Applications/Some App/helper",
    "garbage line",
  ].join("\n");
  const rows = parseProcTable(ps);

  test("parses rows including comm with spaces, skips garbage", () => {
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.pid === 400)?.comm).toBe(
      "/Applications/Some App/helper",
    );
  });

  test("findClaudeDescendant resolves claude under the launcher (AC-2)", () => {
    expect(findClaudeDescendant(200, rows)).toBe(300);
    expect(findClaudeDescendant(400, rows)).toBeNull();
  });

  test("sumTreeRssKB covers launcher + claude + tool children, not siblings (AC-3)", () => {
    expect(sumTreeRssKB(200, rows)).toBe(60000 + 400000 + 10000);
    expect(sumTreeRssKB(999, rows)).toBe(0);
  });

  test("a ppid cycle cannot hang the walk", () => {
    const cyc: ProcRow[] = [
      { pid: 1, ppid: 2, rssKB: 1, comm: "a" },
      { pid: 2, ppid: 1, rssKB: 1, comm: "b" },
    ];
    expect(sumTreeRssKB(1, cyc)).toBe(2);
  });
});

describe("waitForClaudePid", () => {
  test("polls until claude appears and runs onAttempt each time", async () => {
    let calls = 0;
    let attempts = 0;
    const pid = await waitForClaudePid(200, {
      intervalMs: 1,
      list: async () =>
        ++calls < 3
          ? [{ pid: 200, ppid: 1, rssKB: 1, comm: "node" }]
          : [
              { pid: 200, ppid: 1, rssKB: 1, comm: "node" },
              { pid: 301, ppid: 200, rssKB: 1, comm: "/x/claude" },
            ],
      onAttempt: async () => {
        attempts++;
      },
    });
    expect(pid).toBe(301);
    expect(attempts).toBe(3);
  });

  test("returns null on timeout instead of guessing", async () => {
    const pid = await waitForClaudePid(200, {
      attempts: 2,
      intervalMs: 1,
      list: async () => [{ pid: 200, ppid: 1, rssKB: 1, comm: "node" }],
    });
    expect(pid).toBeNull();
  });
});

describe("all-orgs exhaustion (proxy 503)", () => {
  const msg = "API Error: 503 all orgs rate-limited or unreachable";

  test("marker matches the proxy body (claude-org lib/proxy.js refuse(503))", () => {
    expect(ALL_ORGS_EXHAUSTED_MARKER.test(msg)).toBe(true);
    expect(ALL_ORGS_EXHAUSTED_MARKER.test("You've reached your limit")).toBe(
      false,
    );
  });

  test("dialog-detect reports all-orgs-limit as manual-only", () => {
    const m = detectDialog(`some output\n  ⎿  ${msg}\n> `);
    expect(m?.kind).toBe("all-orgs-limit");
    expect(m?.autoAcceptable).toBe(false);
  });

  test("dialog-detect matches the raw JSON 503 body claude prints", () => {
    const json =
      'API Error: 503 {"type":"error","error":{"type":"claude_org_proxy","message":"all orgs rate-limited or unreachable"}}';
    expect(detectDialog(`  ⎿  ${json}\n> `)?.kind).toBe("all-orgs-limit");
  });

  test("dialog-detect ignores the phrase when merely quoted (PR #493 review)", () => {
    // Quoted by the user in the prompt box, or echoed by Claude in prose: no
    // API-error prefix at the start of the line, so not a proxy 503.
    expect(
      detectDialog(
        `> what does "all orgs rate-limited or unreachable" mean?\n`,
      ),
    ).toBeNull();
    expect(
      detectDialog(
        `● The proxy answers "API Error: 503 all orgs rate-limited or unreachable" when every org is exhausted.\n> `,
      ),
    ).toBeNull();
    expect(
      detectDialog(`● all orgs rate-limited or unreachable is the message\n> `),
    ).toBeNull();
  });
});

describe("SessionManager.start when the launcher exits immediately (AC-2)", () => {
  let effects: FakeSessionEffects;
  let manager: SessionManager;
  const saved = process.env.SUPERVISOR_CLAUDE_LAUNCHER;

  beforeEach(() => {
    effects = createFakeEffects();
    manager = new SessionManager({ effects, gracefulKillTimeoutMs: 0 });
    process.env.SUPERVISOR_CLAUDE_LAUNCHER = "ccorg proxy";
  });

  afterEach(async () => {
    await manager.shutdownAll();
    if (saved === undefined) delete process.env.SUPERVISOR_CLAUDE_LAUNCHER;
    else process.env.SUPERVISOR_CLAUDE_LAUNCHER = saved;
  });

  test("tmux session gone and no claude descendant => start fails, nothing registered", async () => {
    const dir = resolve(tmpdir(), `launcher-exit-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const config: ChannelConfig = { channelName: "chan-x", dir, displayName: "X" };
    // The pane pid is read, then the launcher dies and takes the session along.
    const getPid = effects.tmux.getPid.bind(effects.tmux);
    effects.tmux.getPid = async (name: string) => {
      const pid = await getPid(name);
      await effects.tmux.killSession(name);
      return pid;
    };

    await expect(manager.start(config, "t-exit")).rejects.toThrow(
      "起動直後に終了",
    );
    expect(manager.entries().next().done).toBe(true);
  }, 15_000);
});

describe("SessionManager.runHeadless under a launcher", () => {
  let manager: SessionManager;
  let effects: FakeSessionEffects;
  let config: ChannelConfig;
  const saved = {
    l: process.env.SUPERVISOR_CLAUDE_LAUNCHER,
    s: process.env.SUPERVISOR_CLAUDE_LAUNCHER_SCOPE,
  };

  beforeEach(() => {
    effects = createFakeEffects();
    manager = new SessionManager({
      effects,
      gracefulKillTimeoutMs: 0,
      probeArtifactsFn: async () => ({
        status: "found" as const,
        detail: "x",
        dirty: false,
      }),
    });
    const dir = resolve(tmpdir(), `launcher-mgr-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    config = { channelName: "chan-l", dir, displayName: "L" };
    delete process.env.SUPERVISOR_CLAUDE_LAUNCHER_SCOPE;
  });

  afterEach(async () => {
    await manager.shutdownAll();
    for (const [k, v] of [
      ["SUPERVISOR_CLAUDE_LAUNCHER", saved.l],
      ["SUPERVISOR_CLAUDE_LAUNCHER_SCOPE", saved.s],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("launcher unset: argv is unchanged (AC-1)", async () => {
    delete process.env.SUPERVISOR_CLAUDE_LAUNCHER;
    await manager.runHeadless(config, "t-l0", "/impl 1");
    const call = effects.executor.runHeadlessCalls[0]!;
    expect(call.args[0]).toBe("-p");
    expect(call.onStderr).toBeUndefined();
  });

  test("launcher set: it replaces the binary and prefixes argv; banner is kept out of stderr", async () => {
    process.env.SUPERVISOR_CLAUDE_LAUNCHER = "ccorg proxy";
    effects.executor.result = {
      exitCode: 1,
      stdout: "",
      stderr: `${BANNER}\nboom\n`,
      timedOut: false,
      durationMs: 1,
    };
    const res = await manager.runHeadless(config, "t-l1", "/impl 1");
    const call = effects.executor.runHeadlessCalls[0]!;
    expect(call.claudePath).toBe("ccorg");
    expect(call.args.slice(0, 3)).toEqual(["proxy", "-p", "/impl 1"]);
    expect(res.stderr).toBe("boom\n");
  });

  test("scope excluding the channel leaves the launcher off", async () => {
    process.env.SUPERVISOR_CLAUDE_LAUNCHER = "ccorg proxy";
    process.env.SUPERVISOR_CLAUDE_LAUNCHER_SCOPE = "channel:other";
    await manager.runHeadless(config, "t-l2", "/impl 1");
    expect(effects.executor.runHeadlessCalls[0]!.args[0]).toBe("-p");
  });

  test("stop() signals the launcher before claude so neither is orphaned (AC-4)", async () => {
    process.env.SUPERVISOR_CLAUDE_LAUNCHER = "ccorg proxy";
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    effects.executor.runHeadless = async (opts) => {
      opts.onSpawn?.(41_000); // launcher pid
      await held;
      return effects.executor.result;
    };
    const run = manager.runHeadless(config, "t-l3", "/impl 1");
    // The pid-repoint poll cannot find a real claude under fake pid 41000, so
    // stage the resolved state by hand: pid = claude, launcherPid = launcher.
    const live = manager.entries().next().value![1];
    live.pid = 41_001;
    live.launcherPid = 41_000;

    await manager.stop("t-l3", "manual");

    expect(effects.process.killCalls.map((c) => c.pid)).toEqual([41_000, 41_001]);
    release();
    await run;
  });
});
