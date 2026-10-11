import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  waitForClaudePid,
  listProcTable,
  listGroupPids,
  reapLauncherGroup,
  sumTreeRssKB,
  parseProxyBanner,
} from "../../src/session/launcher";
import { ResourceMonitor } from "../../src/session/resource-monitor";
import { AdmissionController } from "../../src/session/admission";
import { SessionManager } from "../../src/session/manager";
import { createFakeEffects } from "../../src/session/adapters-fake";
import type { ProcessAdapter } from "../../src/session/adapters";
import type { ChannelConfig } from "../../src/config/channels";
import type { SessionInfo, StopReason } from "../../src/session/types";

/**
 * Issue #492 AC-2 / AC-3 / AC-4 against REAL processes. The launcher is a bash
 * stand-in for `ccorg proxy` with the same shape: prints the proxy banner on
 * stderr, starts `claude` as a child, forwards SIGTERM to it and waits
 * (claude-org lib/launch.js `runClaude`). `claude` is a symlink to `sleep`, so
 * the process's executable is named `claude` without ever contacting an API.
 */

let dir: string;
let launcherScript: string;
/** Launcher that spawns claude and then dies at once (Issue #494 / PR #495). */
let crashLauncherScript: string;
const spawned: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function startLauncher(): { launcherPid: number; stderr: () => string } {
  const child = spawn(launcherScript, [], {
    env: { ...process.env, CLAUDE_BIN: join(dir, "claude") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  spawned.push(child);
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => (stderr += d));
  return { launcherPid: child.pid!, stderr: () => stderr };
}

/**
 * Spawn a launcher as a process-group leader, the way a tmux pane (setsid) and
 * the headless `detached` spawn both do in production. The group is what
 * SessionManager reaps once the launcher itself is gone.
 */
function startLauncherDetached(script: string): number {
  const child = spawn(script, [], {
    env: { ...process.env, CLAUDE_BIN: join(dir, "claude") },
    stdio: "ignore",
    detached: true,
  });
  spawned.push(child);
  child.unref();
  return child.pid!;
}

/** The claude a detached launcher spawned: the other member of its group. */
async function claudeInGroup(launcherPid: number): Promise<number> {
  let claudePid: number | undefined;
  expect(
    await until(() => {
      claudePid = groupMembersSync(launcherPid).find((p) => p !== launcherPid);
      return claudePid !== undefined;
    }),
  ).toBe(true);
  return claudePid!;
}

function groupMembersSync(pgid: number): number[] {
  return execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([, g]) => g === pgid)
    .map(([p]) => p!);
}

/** Real signals through the adapter seam, so SessionManager reaps real pids. */
const realProcess: ProcessAdapter = {
  kill: (pid, signal) => process.kill(pid, signal),
  isAlive: alive,
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "launcher-real-"));
  const sleepBin = execFileSync("which", ["sleep"], { encoding: "utf8" }).trim();
  symlinkSync(sleepBin, join(dir, "claude"));
  launcherScript = join(dir, "fake-ccorg");
  writeFileSync(
    launcherScript,
    `#!/bin/bash
echo "-> proxy 127.0.0.1:50171 (order: a,b, strategy: order, log: ${dir}/proxy.log)" >&2
"$CLAUDE_BIN" 300 &
child=$!
trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 143' TERM
wait "$child"
`,
  );
  chmodSync(launcherScript, 0o755);
  // Same shape up to the spawn, then the launcher dies with claude still
  // running: the OS re-parents claude to init, outside the launcher's tree.
  crashLauncherScript = join(dir, "fake-ccorg-crash");
  writeFileSync(
    crashLauncherScript,
    `#!/bin/bash
echo "-> proxy 127.0.0.1:50171 (order: a,b, strategy: order, log: ${dir}/proxy.log)" >&2
"$CLAUDE_BIN" 300 &
exit 1
`,
  );
  chmodSync(crashLauncherScript, 0o755);
});

afterAll(() => {
  for (const c of spawned) {
    try {
      process.kill(c.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    execFileSync("pkill", ["-f", join(dir, "claude")]);
  } catch {
    // none left (pkill exits 1)
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("launcher with real processes", () => {
  test("AC-2: the claude descendant is resolved and is named claude", async () => {
    const { launcherPid, stderr } = startLauncher();
    const claudePid = await waitForClaudePid(launcherPid);
    expect(claudePid).not.toBeNull();
    expect(claudePid).not.toBe(launcherPid);
    const comm = execFileSync("ps", ["-o", "comm=", "-p", String(claudePid)], {
      encoding: "utf8",
    }).trim();
    expect(basename(comm)).toBe("claude");
    expect(await until(() => parseProxyBanner(stderr()) !== null)).toBe(true);
    process.kill(launcherPid, "SIGTERM");
  });

  test("AC-3 + AC-4: the memory guard stops the launcher tree and leaves no orphans", async () => {
    const { launcherPid } = startLauncher();
    const claudePid = (await waitForClaudePid(launcherPid))!;

    // The launcher tree is larger than claude alone: the guard sees the proxy.
    const rows = await listProcTable();
    expect(sumTreeRssKB(launcherPid, rows)).toBeGreaterThan(
      sumTreeRssKB(claudePid, rows),
    );

    const session = {
      id: "s",
      channelName: "dev-tool",
      threadId: "t1",
      projectDir: "/x",
      pid: claudePid,
      launcherPid,
      process: null,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      status: "running",
    } as unknown as SessionInfo;
    const sessions = new Map([["t1", session]]);
    const stops: StopReason[] = [];
    const manager = {
      entries: () => sessions.entries(),
      // Same signalling order as SessionManager.stop (launcher, then claude).
      stop: async (threadId: string, reason: StopReason) => {
        stops.push(reason);
        process.kill(session.launcherPid!, "SIGTERM");
        sessions.delete(threadId);
      },
    } as unknown as SessionManager;
    const monitor = new ResourceMonitor(manager, {
      maxMemoryMb: 0,
      admission: new AdmissionController(),
    });

    await monitor.check();

    expect(stops).toEqual(["resource_limit"]);
    expect(await until(() => !alive(claudePid) && !alive(launcherPid))).toBe(
      true,
    );
    // comm= (executable path only): `command=` would also match this test run's
    // own shell, whose command line mentions the fixture paths.
    const left = execFileSync("ps", ["-axo", "pid=,comm="], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((l) => l.includes(join(dir, "claude")));
    expect(left).toEqual([]);
  });

  test("AC-1 (#494): launcher exiting first still lets the guard stop claude", async () => {
    const { launcherPid } = startLauncher();
    const claudePid = (await waitForClaudePid(launcherPid))!;
    // SIGKILL: the launcher cannot forward a signal, so claude is re-parented.
    process.kill(launcherPid, "SIGKILL");
    expect(await until(() => !alive(launcherPid))).toBe(true);
    expect(alive(claudePid)).toBe(true);

    const rows = await listProcTable();
    expect(sumTreeRssKB(launcherPid, rows)).toBe(0);

    const session = {
      id: "s",
      channelName: "dev-tool",
      threadId: "t2",
      projectDir: "/x",
      pid: claudePid,
      launcherPid,
      process: null,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      status: "running",
    } as unknown as SessionInfo;
    const sessions = new Map([["t2", session]]);
    const stops: StopReason[] = [];
    const manager = {
      entries: () => sessions.entries(),
      stop: async (threadId: string, reason: StopReason) => {
        stops.push(reason);
        process.kill(session.pid, "SIGTERM");
        sessions.delete(threadId);
      },
    } as unknown as SessionManager;
    const monitor = new ResourceMonitor(manager, {
      maxMemoryMb: 0,
      admission: new AdmissionController(),
    });

    await monitor.check();

    expect(stops).toEqual(["resource_limit"]);
    expect(await until(() => !alive(claudePid))).toBe(true);
  });
});

/**
 * Issue #494 / PR #495 (Devin must, CodeRabbit Major): a launcher that spawns
 * claude and then dies — or whose tmux pane dies — must not leave that claude
 * running untracked. These drive SessionManager on the DI fakes for tmux but
 * with REAL processes behind the pane pid and real signals.
 */
describe("launcher remnants are reaped (Issue #494)", () => {
  const saved = {
    l: process.env.SUPERVISOR_CLAUDE_LAUNCHER,
    s: process.env.SUPERVISOR_CLAUDE_LAUNCHER_SCOPE,
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  let manager: SessionManager | null = null;
  let config: ChannelConfig;

  beforeEach(() => {
    // The fake tmux never runs the command; the value only has to be set so
    // the launcher branch is taken. Scope pinned like launcher.test.ts.
    process.env.SUPERVISOR_CLAUDE_LAUNCHER = launcherScript;
    process.env.SUPERVISOR_CLAUDE_LAUNCHER_SCOPE = "all";
    const projectDir = join(dir, `proj-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    config = { channelName: "chan-reap", dir: projectDir, displayName: "R" };
  });

  afterEach(async () => {
    await manager?.shutdownAll();
    manager = null;
    restore("SUPERVISOR_CLAUDE_LAUNCHER", saved.l);
    restore("SUPERVISOR_CLAUDE_LAUNCHER_SCOPE", saved.s);
  });

  test("reapLauncherGroup: the claude a crashed launcher left behind is killed", async () => {
    const launcherPid = startLauncherDetached(crashLauncherScript);
    const claudePid = await claudeInGroup(launcherPid);
    expect(await until(() => !alive(launcherPid))).toBe(true);
    expect(alive(claudePid)).toBe(true);
    // Re-parented to init: the descendant search (what resolveLaunchedPids
    // relies on) cannot see it any more — this is the orphan Devin flagged.
    expect(
      await waitForClaudePid(launcherPid, { attempts: 2, intervalMs: 10 }),
    ).toBeNull();
    // ...but the process group survived its leader and still holds claude.
    expect(await listGroupPids(launcherPid)).toEqual([claudePid]);

    expect(await reapLauncherGroup(launcherPid)).toEqual([]);
    expect(alive(claudePid)).toBe(false);
  });

  test("SessionManager.start: launcher spawns claude then exits => start fails and claude does not survive", async () => {
    const effects = createFakeEffects();
    manager = new SessionManager({
      effects: { ...effects, process: realProcess },
      gracefulKillTimeoutMs: 0,
    });
    let claudePid = 0;
    const getPid = effects.tmux.getPid.bind(effects.tmux);
    effects.tmux.getPid = async (name: string) => {
      await getPid(name);
      // The pane process is a real crashing launcher; its exit takes the
      // (fake) tmux session with it, as a real pane would.
      const launcherPid = startLauncherDetached(crashLauncherScript);
      claudePid = await claudeInGroup(launcherPid);
      await until(() => !alive(launcherPid));
      await effects.tmux.killSession(name);
      return launcherPid;
    };

    await expect(manager.start(config, "t-crash")).rejects.toThrow(
      "起動直後に終了",
    );
    expect(manager.entries().next().done).toBe(true);
    expect(claudePid).toBeGreaterThan(0);
    expect(await until(() => !alive(claudePid))).toBe(true);
  }, 20_000);

  test("watchTmuxSession: pane gone under a launcher => claude and launcher are reaped", async () => {
    const effects = createFakeEffects();
    // Record the signals while still delivering them, so the assertion below
    // proves the watcher's reap did the killing (not some incidental exit).
    const killCalls: { pid: number; signal: NodeJS.Signals | number }[] = [];
    const recordingProcess: ProcessAdapter = {
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        realProcess.kill(pid, signal);
      },
      isAlive: alive,
    };
    manager = new SessionManager({
      effects: { ...effects, process: recordingProcess },
      gracefulKillTimeoutMs: 0,
      watchIntervalMs: 20,
    });
    let launcherPid = 0;
    const getPid = effects.tmux.getPid.bind(effects.tmux);
    effects.tmux.getPid = async (name: string) => {
      await getPid(name);
      launcherPid = startLauncherDetached(launcherScript);
      return launcherPid;
    };

    const info = await manager.start(config, "t-pane-gone");
    expect(info.launcherPid).toBe(launcherPid);
    const claudePid = info.pid;
    expect(claudePid).not.toBe(launcherPid);
    expect(alive(claudePid)).toBe(true);

    // The pane disappears (launcher crash, tmux kill-session from outside):
    // the 10s watcher — here 20ms — drops the session, and must take the
    // still-running claude with it rather than leave it to a ResourceMonitor
    // that no longer lists the session.
    await effects.tmux.killSession(
      SessionManager.tmuxSessionNameFor("t-pane-gone"),
    );
    expect(await until(() => manager!.entries().next().done === true)).toBe(
      true,
    );
    expect(await until(() => !alive(claudePid) && !alive(launcherPid))).toBe(
      true,
    );
    expect(killCalls).toEqual([
      { pid: -launcherPid, signal: "SIGTERM" },
      { pid: claudePid, signal: "SIGTERM" },
    ]);
  }, 20_000);
});
