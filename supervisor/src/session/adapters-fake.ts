import type {
  ItermAdapter,
  ProcessAdapter,
  RelayServerAdapter,
  SessionEffects,
  TmuxAdapter,
  WorktreeAdapter,
} from "./adapters";
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

  newSession(name: string, command: string): void {
    this.sessions.set(name, { command, pid: this.pidCounter++ });
  }

  killSession(name: string): void {
    this.sessions.delete(name);
  }

  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }

  getPid(name: string): number | null {
    return this.sessions.get(name)?.pid ?? null;
  }

  ensureSocketConfigured(): void {
    this.ensureSocketConfiguredCalls += 1;
  }

  capturePane(name: string): string {
    return this.paneContent.get(name) ?? "";
  }

  sendKeys(name: string, keys: string[]): void {
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
  /** Worktree paths considered already-present (drives the Q4 reuse path). */
  existingPaths = new Set<string>();
  /** When set, ensure() throws to simulate a git worktree failure. */
  failOnEnsure = false;

  ensure(mainRepoDir: string, branch: string): EnsureWorktreeResult {
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

  remove(mainRepoDir: string, worktreePath: string): void {
    this.removeCalls.push({ mainRepoDir, worktreePath });
    this.existingPaths.delete(worktreePath);
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
