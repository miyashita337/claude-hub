// Tests for scripts/cleanup-idle-claude.sh and scripts/list-claude-processes.sh.
//
// Everything about the decision logic is hermetic: a fake process lister, a
// fake tmux, a fake lsof and a fake ~/.claude/projects tree are injected, and
// the only pids ever signalled are symlink-to-`sleep` stubs this file spawned.
// No real claude process is read for its state or sent a signal.
//
// Exactly two cases touch the live host ("live host smoke"), and both tolerate
// a machine with nothing running — they assert the scripts survive a real
// process table, not that any particular process is up.
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const CLEANUP = resolve(import.meta.dir, "../../../scripts/cleanup-idle-claude.sh");
const LIST = resolve(import.meta.dir, "../../../scripts/list-claude-processes.sh");

async function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", script, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Issue #430 — hermetic fixtures
// ---------------------------------------------------------------------------

/**
 * A process that `is_genuine_claude_executable` accepts: a symlink to `sleep`
 * named `claude`, so `ps -o command=` reports argv[0] with basename `claude`.
 * `sleep` needs no interpreter, which keeps argv[0] ours on both macOS and
 * Linux (a #! script would report the interpreter instead).
 */
interface Stub {
  pid: number;
  proc: ReturnType<typeof Bun.spawn>;
}

let root = "";
let claudeBin = "";
const stubs: Stub[] = [];

function spawnClaudeStub(): Stub {
  const proc = Bun.spawn([claudeBin, "600"], { stdout: "ignore", stderr: "ignore" });
  const stub = { pid: proc.pid, proc };
  stubs.push(stub);
  return stub;
}

/** Write an executable bash stub and return its path. */
function writeStub(name: string, body: string): string {
  const path = `${root}/bin/${name}`;
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Fake `tmux`: answers `list-panes -a -F '#{pane_pid} #{session_activity}
 * #{window_activity}'` from a fixture file, ignoring the socket flags (the real
 * script probes `-L claude-hub` and the inherited socket; both must see the
 * same fixture). `name` keeps concurrent fixtures from overwriting each other.
 */
function fakeTmux(name: string, lines: string[]): string {
  const fixture = `${root}/tmux-panes-${name}.txt`;
  writeFileSync(fixture, lines.length ? lines.join("\n") + "\n" : "");
  return writeStub(`tmux-${name}`, `cat ${JSON.stringify(fixture)}`);
}

/** Fake `lsof`: maps `-p <pid> -d cwd -Fn` to a cwd, in lsof's -F field format. */
function fakeLsof(cwdByPid: Record<number, string>): string {
  const cases = Object.entries(cwdByPid)
    .map(([pid, cwd]) => `    ${pid}) echo "n${cwd}" ;;`)
    .join("\n");
  return writeStub(
    "lsof",
    [
      "pid=''",
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "-p" ]; then pid="$2"; shift 2; else shift; fi',
      "done",
      'case "$pid" in',
      cases,
      "esac",
      "exit 0",
    ].join("\n")
  );
}

/**
 * Fake process lister. ETIME is dictated here rather than measured, so a
 * one-second-old stub can stand in for a long-lived session and exercise the
 * gates past the elapsed-time check.
 */
function fakeLister(rows: { category: string; pid: number; etime?: string }[]): string {
  const body = rows
    .map(
      (r) =>
        `printf "%-16s  %-7s  %-7s  %-12s  %-8s  %-30s  %s\\n" ${JSON.stringify(
          r.category
        )} ${r.pid} 1 ${JSON.stringify(r.etime ?? "10:00:00")} 100 "-" "claude"`
    )
    .join("\n");
  return writeStub(
    "fake-lister",
    ['printf "%s\\n" "CATEGORY  PID  PPID  ETIME  RSS_MB  TMUX_SESSION  CMD"', body].join("\n")
  );
}

/**
 * A PATH carrying everything the script shells out to EXCEPT lsof — the state
 * a macOS host is in, where lsof lives in /usr/sbin and the PATH the supervisor
 * hands its tmux sessions does not include it. Built by resolving each tool so
 * it works on the Linux CI runner too.
 */
function pathWithoutLsof(): string {
  const dir = `${root}/bin-nolsof`;
  mkdirSync(dir, { recursive: true });
  // Everything cleanup-idle-claude.sh (and the fixtures it runs) shells out to.
  for (const cmd of [
    "bash", "ps", "awk", "date", "stat", "sed", "tr", "sleep", "tail", "cat", "dirname",
  ]) {
    const real = Bun.which(cmd);
    if (!real) throw new Error(`test setup: ${cmd} not found on PATH`);
    try {
      symlinkSync(real, `${dir}/${cmd}`);
    } catch {
      // Already linked by an earlier call.
    }
  }
  if (Bun.which("lsof", { PATH: dir })) {
    throw new Error("test setup: lsof leaked into the lsof-free PATH");
  }
  return dir;
}

/** Seed a transcript directory for `cwd` with its newest jsonl aged `ageSec`. */
function seedTranscript(cwd: string, ageSec: number): void {
  const encoded = cwd.replace(/[^A-Za-z0-9-]/g, "-");
  const dir = `${root}/projects/${encoded}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/00000000-0000-0000-0000-000000000000.jsonl`;
  writeFileSync(file, "{}\n");
  const when = new Date(Date.now() - ageSec * 1000);
  utimesSync(file, when, when);
}

beforeAll(() => {
  root = mkdtempSync(`${tmpdir()}/cleanup-idle-430-`);
  mkdirSync(`${root}/bin`, { recursive: true });
  mkdirSync(`${root}/projects`, { recursive: true });
  claudeBin = `${root}/bin/claude`;
  // `sleep` lives in /bin on both macOS and the Linux CI runner.
  symlinkSync("/bin/sleep", claudeBin);
});

afterAll(() => {
  // Only stubs this file spawned. Never a real claude.
  for (const s of stubs) {
    try {
      s.proc.kill("SIGKILL");
    } catch {
      // Already exited (the --apply test kills some of them on purpose).
    }
  }
});

/** Run the cleanup script against injected observation sources. */
async function runCleanup(
  args: string[],
  opts: {
    lister: string;
    tmux?: string;
    lsof?: string;
    lsofFallback?: string;
    env?: Record<string, string>;
  }
) {
  return run(CLEANUP, args, {
    CLEANUP_CLAUDE_LIST_SCRIPT: opts.lister,
    // A path that does not exist makes `command -v` fail, which is exactly how
    // the source reports "this observation channel is unavailable".
    CLEANUP_CLAUDE_TMUX_BIN: opts.tmux ?? `${root}/bin/no-such-tmux`,
    CLEANUP_CLAUDE_LSOF_BIN: opts.lsof ?? `${root}/bin/no-such-lsof`,
    // Neutralised by default so the host's real /usr/sbin/lsof cannot make an
    // "lsof unavailable" case quietly become an available one.
    CLEANUP_CLAUDE_LSOF_FALLBACK: opts.lsofFallback ?? `${root}/bin/no-such-fallback`,
    CLEANUP_CLAUDE_PROJECTS_DIR: `${root}/projects`,
    CLEANUP_CLAUDE_KILL_GRACE_SECONDS: "1",
    ...(opts.env ?? {}),
  });
}

function candidateSection(stdout: string): string {
  const start = stdout.indexOf("Candidates (");
  if (start < 0) return "";
  const end = stdout.indexOf("Protected (", start);
  return stdout.slice(start, end < 0 ? undefined : end);
}

describe("cleanup-idle-claude.sh — CLI surface", () => {
  test("--help exits 0 and prints usage with expected sections", async () => {
    const { exitCode, stdout } = await run(CLEANUP, ["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--apply");
    expect(stdout).toContain("--idle-minutes");
    expect(stdout).toContain("CLEANUP_CLAUDE_ALLOWLIST_PIDS");
  });

  test("unknown flag exits 2", async () => {
    const { exitCode, stderr } = await run(CLEANUP, ["--bogus-flag"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown arg");
  });

  test("default run is dry-run (no signals sent) and exits 0", async () => {
    const { exitCode, stdout } = await runCleanup([], {
      lister: fakeLister([{ category: "interactive", pid: spawnClaudeStub().pid }]),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/mode:\s*dry-run/);
    expect(stdout).toContain("[cleanup-idle-claude]");
  });

  test("--dry-run respects --idle-minutes override", async () => {
    const { exitCode, stdout } = await runCleanup(["--dry-run", "--idle-minutes", "1440"], {
      lister: fakeLister([{ category: "interactive", pid: spawnClaudeStub().pid }]),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/idle_threshold:\s*1440m/);
  });

  test("ALLOWLIST env protects a listed PID from the candidate set", async () => {
    // The pid must actually appear in the lister's output for this to assert
    // anything — pointing it at the test runner's own pid (which the lister
    // never emits) made the original expectation vacuously true.
    const stub = spawnClaudeStub();
    const long_ago = Math.floor(Date.now() / 1000) - 9 * 3600;
    const { exitCode, stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "tmux-other", pid: stub.pid }]),
      tmux: fakeTmux("allowlist", [`${stub.pid} ${long_ago} ${long_ago}`]),
      env: { CLEANUP_CLAUDE_ALLOWLIST_PIDS: String(stub.pid) },
    });
    expect(exitCode).toBe(0);
    expect(candidateSection(stdout)).not.toContain(String(stub.pid));
    expect(stdout).toContain(`${stub.pid}: in CLEANUP_CLAUDE_ALLOWLIST_PIDS`);
  });
});

// The only two cases that read the live host. They assert the scripts survive
// a real process table; everything about the decision logic is pinned
// hermetically below. Both tolerate a host with no claude running (the CI
// runner), so neither depends on something happening to be up.
describe("live host smoke", () => {
  test("list-claude-processes.sh runs read-only and exits 0", async () => {
    const { exitCode, stdout } = await run(LIST, []);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/CATEGORY\s+PID|No claude processes found\./);
  }, 30_000);

  test("cleanup --dry-run against the real process table exits 0", async () => {
    const { exitCode, stdout } = await run(CLEANUP, ["--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/mode:\s*dry-run|no claude processes found/);
    // A dry run reports; it never reaches the signalling branch. (The footer
    // mentions SIGTERM as advice, so match the action line specifically.)
    expect(stdout).not.toContain("-> SIGTERM");
  }, 30_000);
});

describe("cleanup-idle-claude.sh — activity observation (#430)", () => {
  test("AC-1: a session with current tmux activity is protected, not a candidate", async () => {
    const busy = spawnClaudeStub();
    const now = Math.floor(Date.now() / 1000);
    const { exitCode, stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "interactive", pid: busy.pid }]),
      tmux: fakeTmux("busy", [`${busy.pid} ${now} ${now}`]),
    });
    expect(exitCode).toBe(0);
    expect(candidateSection(stdout)).not.toContain(String(busy.pid));
    expect(stdout).toContain(`${busy.pid}: active — tmux-activity`);
  });

  test("AC-1: a session whose transcript was just written is protected", async () => {
    const busy = spawnClaudeStub();
    const cwd = `${root}/work-busy`;
    seedTranscript(cwd, 60);
    const { exitCode, stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "interactive", pid: busy.pid }]),
      lsof: fakeLsof({ [busy.pid]: cwd }),
    });
    expect(exitCode).toBe(0);
    expect(candidateSection(stdout)).not.toContain(String(busy.pid));
    expect(stdout).toContain(`${busy.pid}: active — transcript-mtime`);
  });

  test("AC-2: an untouched tmux session is a candidate (not shielded as subagent)", async () => {
    const dormant = spawnClaudeStub();
    const long_ago = Math.floor(Date.now() / 1000) - 9 * 3600;
    const { exitCode, stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "tmux-other", pid: dormant.pid }]),
      tmux: fakeTmux("dormant", [`${dormant.pid} ${long_ago} ${long_ago}`]),
    });
    expect(exitCode).toBe(0);
    expect(candidateSection(stdout)).toContain(String(dormant.pid));
    // The measurement that justified the kill is printed for review.
    expect(stdout).toMatch(new RegExp(`${dormant.pid}\\s+\\S+\\s+tmux-activity \\d+m-ago`));
  });

  test("AC-3: with no observation source at all, nothing is a candidate", async () => {
    const a = spawnClaudeStub();
    const b = spawnClaudeStub();
    const { exitCode, stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([
        { category: "interactive", pid: a.pid },
        { category: "tmux-other", pid: b.pid },
      ]),
      // Neither tmux nor lsof resolvable — the state this host is actually in
      // (lsof lives in /usr/sbin, absent from the supervisor's PATH).
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No idle claude processes found above threshold.");
    expect(stdout).toContain(`${a.pid}: activity unobservable, protected`);
    expect(stdout).toContain(`${b.pid}: activity unobservable, protected`);
  });

  test("AC-3 regression: lsof answering with no transcript is unknown, not idle", async () => {
    // The exact shape of the original defect: lsof runs fine, but nothing maps
    // the process to a transcript. That must not read as "quiet".
    const stub = spawnClaudeStub();
    const { exitCode, stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "interactive", pid: stub.pid }]),
      lsof: fakeLsof({ [stub.pid]: `${root}/cwd-with-no-project-dir` }),
    });
    expect(exitCode).toBe(0);
    expect(candidateSection(stdout)).not.toContain(String(stub.pid));
    expect(stdout).toContain(`${stub.pid}: activity unobservable, protected`);
  });

  test("--apply re-measures and skips a candidate that woke up, killing only the idle one", async () => {
    const woken = spawnClaudeStub();
    const dormant = spawnClaudeStub();
    const now = Math.floor(Date.now() / 1000);
    const long_ago = now - 9 * 3600;

    const lister = writeStub(
      "fake-lister-apply",
      [
        'printf "%s\\n" "CATEGORY  PID  PPID  ETIME  RSS_MB  TMUX_SESSION  CMD"',
        `printf "%-16s  %-7s  %-7s  %-12s  %-8s  %-30s  %s\\n" "tmux-other" ${woken.pid} 1 "10:00:00" 100 "-" "claude"`,
        `printf "%-16s  %-7s  %-7s  %-12s  %-8s  %-30s  %s\\n" "tmux-other" ${dormant.pid} 1 "10:00:00" 100 "-" "claude"`,
      ].join("\n")
    );

    // A session can wake up between the moment the candidate list is built and
    // the moment the signal is sent, so the fixture has to change mid-run. The
    // stub therefore serves `before` until it has been called `switch` times,
    // then `after`. `switch` is not hardcoded: the dry-run below counts how
    // many calls one full selection pass makes, so this stays correct if the
    // script ever probes a different number of tmux sockets.
    const counter = `${root}/apply-tmux-calls`;
    const switchAt = `${root}/apply-tmux-switch`;
    const before = `${root}/apply-panes-before.txt`;
    const after = `${root}/apply-panes-after.txt`;
    writeFileSync(before, `${woken.pid} ${long_ago} ${long_ago}\n${dormant.pid} ${long_ago} ${long_ago}\n`);
    writeFileSync(after, `${woken.pid} ${now} ${now}\n${dormant.pid} ${long_ago} ${long_ago}\n`);
    writeFileSync(counter, "0");
    writeFileSync(switchAt, "999999");
    const tmux = writeStub(
      "tmux-apply",
      [
        `n=$(cat ${JSON.stringify(counter)})`,
        "n=$((n + 1))",
        `printf '%s' "$n" > ${JSON.stringify(counter)}`,
        `switch=$(cat ${JSON.stringify(switchAt)})`,
        `if [ "$n" -le "$switch" ]; then cat ${JSON.stringify(before)}; else cat ${JSON.stringify(after)}; fi`,
      ].join("\n")
    );

    // Calibration pass: nothing switches, so both processes look idle and both
    // become candidates. This is also the state the old code would have acted
    // on blindly.
    const dry = await runCleanup(["--dry-run"], { lister, tmux });
    expect(candidateSection(dry.stdout)).toContain(String(woken.pid));
    expect(candidateSection(dry.stdout)).toContain(String(dormant.pid));
    const callsPerPass = Number(await Bun.file(counter).text());
    expect(callsPerPass).toBeGreaterThan(0);

    // Apply pass: identical selection, then `woken` is reported active from the
    // first re-measurement onward.
    writeFileSync(counter, "0");
    writeFileSync(switchAt, String(callsPerPass));
    const applied = await runCleanup(["--apply"], { lister, tmux });
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain(`SKIP ${woken.pid}`);
    expect(applied.stdout).toContain(`SIGTERM ${dormant.pid}`);
    expect(applied.stdout).not.toContain(`SIGTERM ${woken.pid}`);

    // The woken stub is still running; the dormant one is gone.
    expect(() => process.kill(woken.pid, 0)).not.toThrow();
    await dormant.proc.exited;
  }, 20_000);
});

describe("cleanup-idle-claude.sh — review follow-ups (#433)", () => {
  test("must-1: tmux answering with unusable activity fields is unknown, not idle", async () => {
    // A tmux that does not understand #{session_activity} substitutes the empty
    // string. `"" + 0` is 0 in awk, and epoch 0 is the most idle value there
    // is — so the pane used to come back as a kill candidate "29443860m-ago".
    const stub = spawnClaudeStub();
    const { exitCode, stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "tmux-other", pid: stub.pid }]),
      tmux: fakeTmux("empty-fields", [`${stub.pid}  `]),
    });
    expect(exitCode).toBe(0);
    expect(candidateSection(stdout)).not.toContain(String(stub.pid));
    expect(stdout).toContain(`${stub.pid}: activity unobservable, protected`);
  });

  test("must-1: a zero epoch is rejected even when it is the only reading", async () => {
    const stub = spawnClaudeStub();
    const { stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "tmux-other", pid: stub.pid }]),
      tmux: fakeTmux("zero-epoch", [`${stub.pid} 0 0`]),
    });
    expect(candidateSection(stdout)).not.toContain(String(stub.pid));
    // The give-away of the old behaviour: an age measured from 1970.
    expect(stdout).not.toMatch(/\d{7,}m-ago/);
  });

  test("should-2: lsof off PATH is found at the fallback path", async () => {
    const stub = spawnClaudeStub();
    const cwd = `${root}/work-fallback`;
    seedTranscript(cwd, 60);
    const { stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "interactive", pid: stub.pid }]),
      // Unresolvable as a bare name, exactly like macOS's /usr/sbin/lsof under
      // the PATH the supervisor hands its sessions.
      lsof: "lsof",
      lsofFallback: fakeLsof({ [stub.pid]: cwd }),
      env: { PATH: pathWithoutLsof() },
    });
    expect(stdout).toContain(`${stub.pid}: active — transcript-mtime`);
  });

  test("should-2: an explicit lsof override that does not resolve is never substituted", async () => {
    // The fallback exists to repair the default. An operator who names a
    // binary and gets a different one back would be worse than the bug.
    const stub = spawnClaudeStub();
    const cwd = `${root}/work-no-substitute`;
    seedTranscript(cwd, 60);
    const { stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "interactive", pid: stub.pid }]),
      lsof: `${root}/bin/no-such-lsof-override`,
      lsofFallback: fakeLsof({ [stub.pid]: cwd }),
    });
    expect(stdout).toContain(`${stub.pid}: activity unobservable, protected`);
  });

  test("should-3: a fresh transcript wins over a stale tmux reading", async () => {
    // The two sources measure different things (pane output vs. transcript
    // writes). Stopping at the first non-empty answer let the older one veto
    // the newer; the newest reading has to win.
    const stub = spawnClaudeStub();
    const cwd = `${root}/work-fresh-transcript`;
    seedTranscript(cwd, 60);
    const long_ago = Math.floor(Date.now() / 1000) - 9 * 3600;
    const { stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "tmux-other", pid: stub.pid }]),
      tmux: fakeTmux("stale", [`${stub.pid} ${long_ago} ${long_ago}`]),
      lsof: fakeLsof({ [stub.pid]: cwd }),
    });
    expect(candidateSection(stdout)).not.toContain(String(stub.pid));
    expect(stdout).toContain(`${stub.pid}: active — transcript-mtime`);
  });

  test("should-3: both sources stale still yields idle, reported from the newer one", async () => {
    const stub = spawnClaudeStub();
    const cwd = `${root}/work-both-stale`;
    seedTranscript(cwd, 4 * 3600);
    const long_ago = Math.floor(Date.now() / 1000) - 9 * 3600;
    const { stdout } = await runCleanup(["--dry-run"], {
      lister: fakeLister([{ category: "tmux-other", pid: stub.pid }]),
      tmux: fakeTmux("both-stale", [`${stub.pid} ${long_ago} ${long_ago}`]),
      lsof: fakeLsof({ [stub.pid]: cwd }),
    });
    const candidates = candidateSection(stdout);
    expect(candidates).toContain(String(stub.pid));
    // 4h transcript is newer than the 9h tmux reading, so it is what gets shown.
    expect(candidates).toContain("transcript-mtime");
  });

  test("should-4: a zero-padded ETIME day count does not abort the run", async () => {
    // macOS `ps` prints "08-01:02:03"; bash reads a leading zero as octal, so
    // `08` was an arithmetic error that took the whole run down under `set -e`
    // — including --dry-run, leaving the operator with no listing at all.
    const stub = spawnClaudeStub();
    const long_ago = Math.floor(Date.now() / 1000) - 9 * 3600;
    for (const etime of ["08-01:02:03", "09-00:00:00", "10-00:00:00"]) {
      const { exitCode, stdout } = await runCleanup(["--dry-run"], {
        lister: fakeLister([{ category: "tmux-other", pid: stub.pid, etime }]),
        tmux: fakeTmux(`etime-${etime.slice(0, 2)}`, [`${stub.pid} ${long_ago} ${long_ago}`]),
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("[cleanup-idle-claude]");
      // Decimal, not octal: 10 days must clear a 12000-minute (8.3d) threshold.
      expect(candidateSection(stdout)).toContain(String(stub.pid));
    }
  }, 20_000);

  test("should-4: 10 days is read as decimal, not octal", async () => {
    const stub = spawnClaudeStub();
    // Quiet for longer than the threshold below, so only the ETIME gate is
    // under test here.
    const long_ago = Math.floor(Date.now() / 1000) - 20 * 24 * 3600;
    // 10 days = 14400 minutes decimal, but 8 days = 11520 if read as octal —
    // which would fall short of this threshold and protect the process.
    const { stdout } = await runCleanup(["--dry-run", "--idle-minutes", "12000"], {
      lister: fakeLister([{ category: "tmux-other", pid: stub.pid, etime: "10-00:00:00" }]),
      tmux: fakeTmux("etime-decimal", [`${stub.pid} ${long_ago} ${long_ago}`]),
    });
    expect(candidateSection(stdout)).toContain(String(stub.pid));
  });

  test("should-1: the identity guard is re-asserted in the kill loop", async () => {
    // Behavioural coverage is not constructible (it needs a pid to be recycled
    // into a non-claude process between selection and signal), so this pins the
    // wiring the comment claims: the guard runs again after the re-observation
    // and before `kill -TERM`.
    const src = await Bun.file(CLEANUP).text();
    const applyIdx = src.indexOf("KILLED_STR=\",\"");
    const guardCalls = [...src.matchAll(/is_genuine_claude_executable "\$/g)].map((m) => m.index ?? -1);
    expect(applyIdx).toBeGreaterThan(-1);
    expect(guardCalls.length).toBeGreaterThanOrEqual(2);
    expect(guardCalls.some((i) => i > applyIdx)).toBe(true);
    expect(src.indexOf("kill -TERM")).toBeGreaterThan(
      guardCalls.filter((i) => i > applyIdx)[0] as number
    );
  });
});

describe("list-claude-processes.sh — classification predicates (#430)", () => {
  /** Source the lister as a library and evaluate one expression against it. */
  async function evalInLister(snippet: string) {
    const proc = Bun.spawn(
      ["bash", "-c", `LIST_CLAUDE_PROCESSES_LIB_ONLY=1 source ${JSON.stringify(LIST)}; ${snippet}`],
      { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { exitCode, stdout: stdout.trim() };
  }

  test("supervisor-formula session names are recognised, hand-made ones are not", async () => {
    // `claude-<threadId12>` per SessionManager.tmuxSessionNameFor().
    for (const name of ["claude-153700777499", "claude-1"]) {
      const { exitCode } = await evalInLister(`is_supervisor_session_name ${JSON.stringify(name)}`);
      expect(exitCode).toBe(0);
    }
    // The two sessions that Issue #430 found permanently shielded.
    for (const name of ["claude-x", "claude-tricky", "claude-", "claude-1537007774990"]) {
      const { exitCode } = await evalInLister(`is_supervisor_session_name ${JSON.stringify(name)}`);
      expect(exitCode).not.toBe(0);
    }
  });

  test("a parent whose argv merely contains 'claude' is not read as the claude binary", async () => {
    // Shaped like the real supervisor tmux server:
    //   /opt/homebrew/bin/tmux -L claude-hub new-session -d -s claude-<id> ...
    // Its command line spells "claude", its argv[0] basename does not.
    const dir = `${root}/claude-hub`;
    mkdirSync(dir, { recursive: true });
    const tmuxLike = `${dir}/tmux`;
    symlinkSync("/bin/sleep", tmuxLike);
    const proc = Bun.spawn([tmuxLike, "600"], { stdout: "ignore", stderr: "ignore" });
    stubs.push({ pid: proc.pid, proc });

    const { stdout } = await evalInLister(`argv0_basename ${proc.pid}`);
    expect(stdout).toBe("tmux");

    // Guard the premise: the substring test the old classifier used would have
    // matched here, which is how every pane on that socket became a "subagent".
    const cmd = Bun.spawnSync(["ps", "-p", String(proc.pid), "-o", "command="]);
    expect(cmd.stdout.toString()).toContain("claude");
  });

  test("argv0_basename reports 'claude' for a real claude-named process", async () => {
    const stub = spawnClaudeStub();
    const { stdout } = await evalInLister(`argv0_basename ${stub.pid}`);
    expect(stdout).toBe("claude");
  });
});
