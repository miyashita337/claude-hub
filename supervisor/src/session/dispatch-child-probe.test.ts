import { test, expect, describe } from "bun:test";
import {
  BUSY_COMMAND_RE,
  parsePsOutput,
  collectDescendants,
  hasBusyDescendant,
  classifyProbe,
  realBusyChildProbe,
  type ProcRow,
} from "./dispatch-child-probe";

// Issue #279. The child-process probe is the mis-fire guard that separates
// "silent because genuinely idle" (safe to auto-reap) from "silent because a
// long CI/build/test is running" (must be spared — stop() removes the worktree
// and would discard in-flight work). All shell access is injected so these unit
// tests never spawn `ps` or `tmux`. Danger is asymmetric: a false "idle" reaps a
// working session, a false "busy" only delays reaping (48h orphan backstop still
// catches it), so the matcher is deliberately generous toward "busy".

describe("BUSY_COMMAND_RE", () => {
  test("matches active build/CI/test/push commands", () => {
    for (const cmd of [
      "cargo build --release",
      "/opt/homebrew/bin/cargo test",
      "node /repo/node_modules/.bin/vitest run",
      "jest --watch",
      "playwright test",
      "python -m pytest tests/",
      "tsc -w -p tsconfig.json",
      "gh pr checks 123 --watch",
      "gh run watch",
      "git push origin feat/x",
      "git fetch origin main",
      "pnpm run build",
      "npm ci",
      "yarn test",
      "bun test src/",
      "bun run build",
      "make -j8",
      "vite build",
      "esbuild src/index.ts",
      "eslint .",
      "docker build -t x .",
    ]) {
      expect(BUSY_COMMAND_RE.test(cmd)).toBe(true);
    }
  });

  test("does NOT match the agent runtime / shells (false-positive floor)", () => {
    // These are ALWAYS present under a live pane; matching them would make every
    // session look busy forever and defeat auto-reap entirely.
    for (const cmd of [
      "claude",
      "/Users/x/.bun/bin/claude --resume abc",
      "node /usr/local/lib/claude/cli.js",
      "bun /supervisor/index.ts",
      "-zsh",
      "/bin/bash -l",
      "login -pf user",
      "tmux -L claude-hub attach",
      "less /var/log/x",
    ]) {
      expect(BUSY_COMMAND_RE.test(cmd)).toBe(false);
    }
  });
});

describe("parsePsOutput", () => {
  test("parses pid/ppid/command triples and ignores junk lines", () => {
    const out = [
      "  501  1 /sbin/launchd",
      " 1234 501 -zsh",
      " 5678 1234 cargo build",
      "garbage line without numbers",
      "",
    ].join("\n");
    const rows = parsePsOutput(out);
    expect(rows).toEqual([
      { pid: 501, ppid: 1, command: "/sbin/launchd" },
      { pid: 1234, ppid: 501, command: "-zsh" },
      { pid: 5678, ppid: 1234, command: "cargo build" },
    ]);
  });
});

describe("collectDescendants", () => {
  const rows: ProcRow[] = [
    { pid: 100, ppid: 1, command: "-zsh" }, // pane root
    { pid: 200, ppid: 100, command: "claude" }, // agent
    { pid: 300, ppid: 200, command: "bash -c cargo build" }, // tool shell
    { pid: 400, ppid: 300, command: "cargo build" }, // deep descendant
    { pid: 999, ppid: 1, command: "unrelated" }, // sibling tree
  ];

  test("walks the whole subtree (transitive), excluding the root itself", () => {
    const got = collectDescendants(100, rows)
      .map((r) => r.pid)
      .sort((a, b) => a - b);
    expect(got).toEqual([200, 300, 400]);
  });

  test("a leaf pane with no children yields nothing", () => {
    expect(collectDescendants(999, rows)).toEqual([]);
  });

  test("is cycle-safe (a malformed ppid loop does not hang)", () => {
    const loop: ProcRow[] = [
      { pid: 1, ppid: 2, command: "a" },
      { pid: 2, ppid: 1, command: "b" },
    ];
    // Must terminate; from root 1 the only reachable descendant is 2.
    expect(collectDescendants(1, loop).map((r) => r.pid)).toEqual([2]);
  });
});

describe("hasBusyDescendant", () => {
  test("true when any descendant is a busy command", () => {
    const rows: ProcRow[] = [
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: "claude" },
      { pid: 300, ppid: 200, command: "cargo test" },
    ];
    expect(hasBusyDescendant(100, rows)).toBe(true);
  });

  test("false when the subtree is only the agent + shells (genuinely idle)", () => {
    const rows: ProcRow[] = [
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: "claude --resume abc" },
      { pid: 300, ppid: 200, command: "/bin/bash" },
    ];
    expect(hasBusyDescendant(100, rows)).toBe(false);
  });
});

describe("classifyProbe", () => {
  const busyRows: ProcRow[] = [
    { pid: 100, ppid: 1, command: "-zsh" },
    { pid: 200, ppid: 100, command: "cargo build" },
  ];
  const idleRows: ProcRow[] = [
    { pid: 100, ppid: 1, command: "-zsh" },
    { pid: 200, ppid: 100, command: "claude" },
  ];

  test("null pane pid → unknown (fail-safe)", () => {
    expect(classifyProbe(null, idleRows)).toBe("unknown");
  });
  test("null process table → unknown (fail-safe)", () => {
    expect(classifyProbe(100, null)).toBe("unknown");
  });
  test("busy descendant → busy", () => {
    expect(classifyProbe(100, busyRows)).toBe("busy");
  });
  test("no busy descendant → idle", () => {
    expect(classifyProbe(100, idleRows)).toBe("idle");
  });
});

describe("realBusyChildProbe (deps injected — no shell)", () => {
  const idleRows: ProcRow[] = [
    { pid: 100, ppid: 1, command: "-zsh" },
    { pid: 200, ppid: 100, command: "claude" },
  ];

  test("unknown when the tmux pane pid cannot be resolved (fail-safe)", async () => {
    const got = await realBusyChildProbe("thread-abc", {
      getPanePid: async () => null,
      listProcesses: async () => idleRows,
    });
    expect(got).toBe("unknown");
  });

  test("idle when the resolved subtree has no busy descendant", async () => {
    const got = await realBusyChildProbe("thread-abc", {
      getPanePid: async () => 100,
      listProcesses: async () => idleRows,
    });
    expect(got).toBe("idle");
  });

  test("busy when the resolved subtree has a busy descendant", async () => {
    const got = await realBusyChildProbe("thread-abc", {
      getPanePid: async () => 100,
      listProcesses: async () => [
        ...idleRows,
        { pid: 300, ppid: 200, command: "gh pr checks --watch" },
      ],
    });
    expect(got).toBe("busy");
  });

  test("unknown when the process listing fails (fail-safe)", async () => {
    const got = await realBusyChildProbe("thread-abc", {
      getPanePid: async () => 100,
      listProcesses: async () => null,
    });
    expect(got).toBe("unknown");
  });
});
