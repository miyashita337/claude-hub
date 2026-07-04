import { test, expect, describe, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { realExecutorAdapter } from "../../src/session/adapters";
import { FakeExecutorAdapter } from "../../src/session/adapters-fake";

/**
 * Epic #285 Phase 2 / #286: the headless executor adapter. The fake is asserted
 * for argv/cwd/onSpawn (the seam unit tests rely on), and the REAL Bun.spawn
 * adapter is exercised against tiny stub scripts so stdout capture, non-zero
 * exit, and the timeout kill are covered end-to-end without a real `claude`.
 */

const workdir = mkdtempSync(join(tmpdir(), "headless-exec-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

/** Write an executable stub script and return its absolute path. */
function stub(name: string, body: string): string {
  const p = join(workdir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("FakeExecutorAdapter", () => {
  test("records argv/cwd/env and fires onSpawn with a pid", async () => {
    const fake = new FakeExecutorAdapter();
    fake.result = { exitCode: 0, stdout: "hi", stderr: "", timedOut: false };
    const pids: number[] = [];

    const r = await fake.runHeadless({
      claudePath: "/x/claude",
      args: ["-p", "/impl 7", "--session-id", "abc"],
      cwd: "/work/tree",
      env: { PATH: "/bin" },
      timeoutMs: 1000,
      onSpawn: (pid) => pids.push(pid),
    });

    expect(r.stdout).toBe("hi");
    expect(fake.runHeadlessCalls).toHaveLength(1);
    expect(fake.runHeadlessCalls[0]!.args).toEqual([
      "-p",
      "/impl 7",
      "--session-id",
      "abc",
    ]);
    expect(fake.runHeadlessCalls[0]!.cwd).toBe("/work/tree");
    expect(pids).toHaveLength(1);
    expect(pids[0]).toBeGreaterThan(0);
  });

  test("failOnSpawn throws and never fires onSpawn (no session to register)", async () => {
    const fake = new FakeExecutorAdapter();
    fake.failOnSpawn = true;
    let spawned = false;
    await expect(
      fake.runHeadless({
        claudePath: "/x/claude",
        args: [],
        cwd: "/tmp",
        env: {},
        timeoutMs: 100,
        onSpawn: () => {
          spawned = true;
        },
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(spawned).toBe(false);
  });
});

describe("realExecutorAdapter (Bun.spawn)", () => {
  test("captures stdout and exit 0, fires onSpawn with the real pid", async () => {
    const bin = stub("echo0.sh", 'printf "%s" "$1"\nexit 0');
    let pid = 0;
    const r = await realExecutorAdapter.runHeadless({
      claudePath: bin,
      args: ["hello-stdout"],
      cwd: workdir,
      env: { ...process.env },
      timeoutMs: 5000,
      onSpawn: (p) => {
        pid = p;
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("hello-stdout");
    expect(pid).toBeGreaterThan(0);
  });

  test("surfaces a non-zero exit code as data (not a throw)", async () => {
    const bin = stub("exit3.sh", 'echo out\necho err 1>&2\nexit 3');
    const r = await realExecutorAdapter.runHeadless({
      claudePath: bin,
      args: [],
      cwd: workdir,
      env: { ...process.env },
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });

  test("kills the child and reports timedOut when it overruns", async () => {
    const bin = stub("sleep.sh", 'sleep 10\necho done');
    const started = Date.now();
    const r = await realExecutorAdapter.runHeadless({
      claudePath: bin,
      args: [],
      cwd: workdir,
      env: { ...process.env },
      timeoutMs: 150,
    });
    // Must return promptly (killed), long before the 10s sleep would finish.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.timedOut).toBe(true);
    // On a timeout kill the numeric exit code is not meaningful → null.
    expect(r.exitCode).toBeNull();
    expect(r.stdout).not.toContain("done");
  });
});
