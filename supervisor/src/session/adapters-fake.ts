import type {
  ItermAdapter,
  ProcessAdapter,
  RelayServerAdapter,
  SessionEffects,
  TmuxAdapter,
  WorktreeAdapter,
} from "./adapters";
import { mkdirSync } from "fs";
import { resolveWorktreePath, type EnsureWorktreeResult } from "./worktree";
import type { OpenTabOptions } from "./iterm2";

/**
 * In-memory fakes for the {@link SessionEffects} interfaces. Used by unit
 * tests to avoid spawning real tmux sessions, iTerm2 tabs, HTTP servers, or
 * sending real OS signals. See Issue #61.
 */

export class FakeTmuxAdapter implements TmuxAdapter {
  private sessions = new Map<string, { command: string; pid: number }>();
  private pidCounter = 10_000;
  ensureSocketConfiguredCalls = 0;
  /** Programmable pane buffers returned by capturePane(). */
  private paneContent = new Map<string, string>();
  /** Records every sendKeys() call so tests can assert prompt confirmation. */
  sendKeysCalls: { name: string; keys: string[] }[] = [];
  /** When set, sendKeys() throws to simulate a failure during prompt confirm. */
  failOnSendKeys = false;

  // Issue #227 (PR-3): the TmuxAdapter interface methods are now async, so the
  // fakes return Promises too. The in-memory bookkeeping stays synchronous; the
  // `async` keyword just wraps the result so `await fake.x()` matches production.
  async newSession(name: string, command: string): Promise<void> {
    this.sessions.set(name, { command, pid: this.pidCounter++ });
  }

  async killSession(name: string): Promise<void> {
    this.sessions.delete(name);
  }

  async hasSession(name: string): Promise<boolean> {
    return this.sessions.has(name);
  }

  async getPid(name: string): Promise<number | null> {
    return this.sessions.get(name)?.pid ?? null;
  }

  // Issue #227 (PR-4): ensureSocketConfigured is async now. The counter bump
  // runs synchronously (before the first await), so existing
  // `ensureSocketConfiguredCalls` assertions still hold even when the call is
  // not awaited (e.g. the constructor's fire-and-forget invocation).
  async ensureSocketConfigured(): Promise<void> {
    this.ensureSocketConfiguredCalls += 1;
  }

  async capturePane(name: string): Promise<string> {
    return this.paneContent.get(name) ?? "";
  }

  async sendKeys(name: string, keys: string[]): Promise<void> {
    this.sendKeysCalls.push({ name, keys });
    if (this.failOnSendKeys) {
      throw new Error("sendKeys failed");
    }
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Test-only: read the bash command stored for a tmux session. */
  getCommand(name: string): string | null {
    return this.sessions.get(name)?.command ?? null;
  }

  /** Test-only: set what capturePane() returns for a session. */
  setPaneContent(name: string, content: string): void {
    this.paneContent.set(name, content);
  }
}

export class FakeItermAdapter implements ItermAdapter {
  openTabCalls: OpenTabOptions[] = [];
  markTabStoppedCalls: { channelName: string; tmuxSessionName?: string }[] =
    [];

  openTab(opts: OpenTabOptions): void {
    this.openTabCalls.push(opts);
  }

  markTabStopped(channelName: string, tmuxSessionName?: string): void {
    this.markTabStoppedCalls.push({ channelName, tmuxSessionName });
  }
}

export class FakeRelayServerAdapter implements RelayServerAdapter {
  startCalls = 0;
  stopCalls = 0;
  cancelCalls: string[] = [];
  port = 12_345;

  start(): void {
    this.startCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  getPort(): number {
    return this.port;
  }

  cancel(threadId: string): void {
    this.cancelCalls.push(threadId);
  }
}

export class FakeProcessAdapter implements ProcessAdapter {
  killCalls: { pid: number; signal: NodeJS.Signals | number }[] = [];
  failOnKill = false;
  /** Pids that {@link isAlive} should report as alive. Anything else is dead. */
  alivePids = new Set<number>();

  kill(pid: number, signal: NodeJS.Signals | number): void {
    this.killCalls.push({ pid, signal });
    if (this.failOnKill) {
      throw new Error("process not found");
    }
  }

  isAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }
}

export class FakeWorktreeAdapter implements WorktreeAdapter {
  ensureCalls: { mainRepoDir: string; branch: string }[] = [];
  removeCalls: { mainRepoDir: string; worktreePath: string }[] = [];
  recreateForBranchCalls: { mainRepoDir: string; branch: string }[] = [];
  /** Worktree paths considered already-present (drives the Q4 reuse path). */
  existingPaths = new Set<string>();
  /**
   * Branch names that still resolve in the repo (Issue #217). Drives the Q1
   * checkout in {@link recreateForBranch}: a branch NOT in this set is treated
   * as deleted, so recovery returns false.
   */
  existingBranches = new Set<string>();
  /** When set, ensure() throws to simulate a git worktree failure. */
  failOnEnsure = false;

  // Issue #227 (PR-4): the WorktreeAdapter interface methods are now async, so
  // the fakes return Promises too. The in-memory bookkeeping stays synchronous;
  // the `async` keyword just wraps the result so `await fake.x()` matches
  // production (a `failOnEnsure` throw becomes a rejected Promise as before).
  async ensure(mainRepoDir: string, branch: string): Promise<EnsureWorktreeResult> {
    this.ensureCalls.push({ mainRepoDir, branch });
    if (this.failOnEnsure) {
      throw new Error("git worktree add failed");
    }
    // Use the real path resolver so the traversal / shell-injection guards are
    // exercised through manager-level tests too (not just worktree.test.ts).
    const path = resolveWorktreePath(mainRepoDir, branch.trim());
    const reused = this.existingPaths.has(path);
    this.existingPaths.add(path);
    return { path, reused };
  }

  async remove(mainRepoDir: string, worktreePath: string): Promise<void> {
    this.removeCalls.push({ mainRepoDir, worktreePath });
    this.existingPaths.delete(worktreePath);
  }

  async recreateForBranch(mainRepoDir: string, branch: string): Promise<boolean> {
    this.recreateForBranchCalls.push({ mainRepoDir, branch });
    const path = resolveWorktreePath(mainRepoDir, branch.trim());
    if (this.existingPaths.has(path)) return true; // Q4: already present
    if (!this.existingBranches.has(branch.trim())) return false; // branch gone
    // Q1: materialize the real directory so SessionManager's own existsSync()
    // re-check passes after recovery (manager runs against the real fs). Tests
    // must clean this up — the dir lives under <mainRepoDir>/.claude/worktrees,
    // so an afterEach `rmSync(repoDir, { recursive: true })` removes it too.
    mkdirSync(path, { recursive: true });
    this.existingPaths.add(path);
    return true;
  }
}

export interface FakeSessionEffects extends SessionEffects {
  tmux: FakeTmuxAdapter;
  iterm2: FakeItermAdapter;
  relayServer: FakeRelayServerAdapter;
  process: FakeProcessAdapter;
  worktree: FakeWorktreeAdapter;
}

export function createFakeEffects(): FakeSessionEffects {
  return {
    tmux: new FakeTmuxAdapter(),
    iterm2: new FakeItermAdapter(),
    relayServer: new FakeRelayServerAdapter(),
    process: new FakeProcessAdapter(),
    worktree: new FakeWorktreeAdapter(),
  };
}
