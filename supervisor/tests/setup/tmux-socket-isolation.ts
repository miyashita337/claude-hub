// Issue #476: hermetic tmux socket for `bun test`.
//
// src/session/tmux.ts binds TMUX_SOCKET / TMUX_ARGS at module load from
// SUPERVISOR_TMUX_SOCKET, defaulting to the PRODUCTION socket `claude-hub`.
// Tests that create real tmux sessions (relay-submit-confirm, e2e, ...) therefore
// leaked relay*/ac-e2e* sessions into the live Supervisor's server whenever the
// env var was not set by hand, and parallel runs collided on the same socket.
//
// This preload (wired via bunfig.toml [test].preload, so it runs before any test
// file imports tmux.ts) repoints the socket at a per-process test socket. An
// explicit non-production value (CI passes `claude-hub-test`, which the e2e
// suites REQUIRE) is respected; only unset or the production name is rewritten.
import { afterAll } from "bun:test";
import { spawnSync } from "child_process";

const PRODUCTION_SOCKET = "claude-hub";
const ownSocket = `claude-hub-test-${process.pid}`;

const requested = process.env.SUPERVISOR_TMUX_SOCKET;
const isolatedSocket =
  requested && requested !== PRODUCTION_SOCKET ? requested : ownSocket;
process.env.SUPERVISOR_TMUX_SOCKET = isolatedSocket;

// Only tear down the per-process socket we created; an explicitly supplied
// socket (e.g. CI's shared `claude-hub-test`) is owned by whoever set it.
const ownsSocket = isolatedSocket === ownSocket;
const cleanup = () => {
  if (!ownsSocket) return;
  try {
    // kill-server on the test socket only; never touches `-L claude-hub`.
    spawnSync(
      // PATH fallback: a hard-coded Homebrew path would silently skip cleanup on
      // Linux runners that don't set TMUX_PATH.
      process.env.TMUX_PATH ?? "tmux",
      ["-L", isolatedSocket, "kill-server"],
      { stdio: "ignore", timeout: 3000 },
    );
  } catch {
    // tmux absent or server already gone: nothing to clean up
  }
};

// A failing run can exit without firing the JS `exit` event, which previously
// left the leaked server alive; afterAll runs regardless of test outcome.
afterAll(cleanup);
process.on("exit", cleanup);
// SIGINT / SIGTERM do not fire `exit`; clean up, then keep interrupt semantics.
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
