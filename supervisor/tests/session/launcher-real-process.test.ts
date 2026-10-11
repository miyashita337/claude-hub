import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import {
  mkdtempSync,
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
  sumTreeRssKB,
  parseProxyBanner,
} from "../../src/session/launcher";
import { ResourceMonitor } from "../../src/session/resource-monitor";
import { AdmissionController } from "../../src/session/admission";
import type { SessionManager } from "../../src/session/manager";
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
