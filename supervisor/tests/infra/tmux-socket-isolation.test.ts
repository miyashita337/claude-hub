// Issue #476: regression guard for the tmux socket preload
// (tests/setup/tmux-socket-isolation.ts). Removing the preload, or letting a
// failing test leave sessions behind, must show up as a failing test instead of
// silently re-exposing the production `-L claude-hub` server.
import { describe, test, expect } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { TMUX_PATH, TMUX_SOCKET, TMUX_ARGS } from "../../src/session/tmux";

function tmuxAvailable(): boolean {
  try {
    execFileSync(TMUX_PATH, ["-V"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
const ittmux = tmuxAvailable() ? test : test.skip;

const SUPERVISOR_DIR = resolve(import.meta.dir, "../..");

describe("tmux socket isolation (#476)", () => {
  test("TMUX_SOCKET is never the production socket under bun test", () => {
    expect(TMUX_SOCKET).not.toBe("claude-hub");
    expect(TMUX_ARGS).toEqual(["-L", TMUX_SOCKET]);
    expect(TMUX_SOCKET.startsWith("claude-hub-test")).toBe(true);
  });

  ittmux(
    "a failing test that leaves a session behind does not leak it (socket is torn down)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "tmux-iso-476-"));
      try {
        const fixture = join(dir, "leaky.test.ts");
        writeFileSync(
          fixture,
          `import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { TMUX_PATH, TMUX_ARGS, TMUX_SOCKET } from ${JSON.stringify(
            join(SUPERVISOR_DIR, "src/session/tmux"),
          )};
test("leak then fail", () => {
  execFileSync(TMUX_PATH, [...TMUX_ARGS, "new-session", "-d", "-s", "leak476", "sleep", "300"]);
  console.log("SOCKET=" + TMUX_SOCKET);
  expect(1).toBe(2);
});
`,
        );
        const env: Record<string, string | undefined> = { ...process.env, TMUX_PATH };
        delete env.SUPERVISOR_TMUX_SOCKET;
        const res = spawnSync("bun", ["test", fixture], {
          cwd: SUPERVISOR_DIR,
          env,
          encoding: "utf8",
          timeout: 60_000,
        });
        const out = `${res.stdout}\n${res.stderr}`;
        const m = out.match(/SOCKET=(\S+)/);
        expect(m).not.toBeNull();
        const socket = m![1]!;
        expect(socket).not.toBe("claude-hub");
        expect(res.status).not.toBe(0); // fixture failed on purpose

        // After the child exited, its per-process server must be gone.
        let alive = true;
        try {
          execFileSync(TMUX_PATH, ["-L", socket, "ls"], { stdio: "ignore", timeout: 3000 });
        } catch {
          alive = false;
        }
        if (alive) {
          try {
            execFileSync(TMUX_PATH, ["-L", socket, "kill-server"], { stdio: "ignore" });
          } catch {
            // best effort so a failed assertion does not itself leak
          }
        }
        expect(alive).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
