import { execFile } from "child_process";
import { promisify } from "util";
import type { SessionManager } from "./manager";
import type { ThreadChannel, Client } from "discord.js";
import { GOAL_CHECK_INTERVAL_MS, GOAL_GRACE_MS } from "../config/channels";
import { markTitleStopped } from "./thread-title";

const execFileAsync = promisify(execFile);

/**
 * Dispatch-origin branch shape (corp #52 / spec §7). The corp HQ posts
 * `/dispatch corp-dispatch-<N> <N> ...`, so a session running on a branch that
 * matches this pattern is a dispatch job whose lifecycle we own; its single
 * capture group is the GitHub Issue number. The corp conductor session (no
 * branch, or a work branch like `52-m1-board`) deliberately does NOT match, so
 * it is excluded from auto-stop (spec AC-6).
 */
export const DISPATCH_BRANCH_RE = /^corp-dispatch-(\d+)$/;

/**
 * The single terminal phase label (spec §8). Its presence — NOT Issue close —
 * is the auto-stop trigger (spec §7 / AC-7): devcycle closes the Issue when the
 * PR merges, but production deploy + prod E2E still run afterward, so closing
 * must not kill the session. The playbook adds `done` only at the true end.
 */
const DONE_LABEL = "done";

export interface GoalWatcherDeps {
  /**
   * Fetch the GitHub label names for Issue `issueNumber`, resolved from the git
   * remote at `repoDir`. Injected so unit tests never shell out. The real
   * implementation is fail-soft (returns `[]` on any gh error) — a transient
   * rate-limit / auth blip must never stop a live session.
   */
  fetchIssueLabels?: (repoDir: string, issueNumber: number) => Promise<string[]>;
  /** Clock injection for deterministic grace-window tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Poll interval. Defaults to {@link GOAL_CHECK_INTERVAL_MS}. */
  checkIntervalMs?: number;
  /** Grace window after `done` is first seen before stopping. Defaults to {@link GOAL_GRACE_MS}. */
  graceMs?: number;
}

/** State of an open grace window for one thread after `done` was first seen. */
interface PendingStop {
  /** Injected-clock time when `done` was first observed. */
  detectedAt: number;
  /** Snapshot of the session's `lastActivityAt` at detection; a later value means the chairman spoke. */
  activityAtDetection: number;
}

/**
 * Real label fetch via `gh issue view`. Mirrors worktree.ts: async `execFile`
 * with an argv array (no shell), repo resolved from `cwd`. Fail-soft: any error
 * (gh missing / unauthenticated / no GitHub remote / issue unreadable) yields
 * `[]` so the watcher treats it as "not done yet" rather than stopping blindly.
 */
async function realFetchIssueLabels(
  repoDir: string,
  issueNumber: number
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "labels",
        "--jq",
        ".labels[].name",
      ],
      { cwd: repoDir, encoding: "utf8" }
    );
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Reaper's sibling for goal-driven teardown (corp #52 M3, spec §7). On a fixed
 * interval it scans live sessions, keeps only the dispatch-origin ones
 * (`corp-dispatch-<N>`), and when the Issue carries the `done` label it stops
 * the session with reason `goal_complete` after a cancellable grace window. This
 * is the L4 saturation fix: completed dispatch sessions free their slot instead
 * of idling until the 7-day reaper.
 *
 * Self-contained per spec §12 (no new corp→claude-hub structural coupling): it
 * reads only the branch naming convention + GitHub labels and reuses the
 * existing `sessionManager.stop`.
 */
export class GoalWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Re-entry guard (mirrors {@link SessionManager}'s watchTmuxSession). Each
   * `check()` awaits one gh call per dispatch session, which can outlast the
   * poll interval under load; without this two ticks could overlap and both
   * decide to stop the same thread.
   */
  private isChecking = false;
  /** threadId → open grace window. */
  private readonly pending = new Map<string, PendingStop>();

  private readonly fetchIssueLabels: NonNullable<
    GoalWatcherDeps["fetchIssueLabels"]
  >;
  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private readonly graceMs: number;

  constructor(
    private sessionManager: SessionManager,
    private client: Client,
    deps: GoalWatcherDeps = {}
  ) {
    this.fetchIssueLabels = deps.fetchIssueLabels ?? realFetchIssueLabels;
    this.now = deps.now ?? Date.now;
    this.checkIntervalMs = deps.checkIntervalMs ?? GOAL_CHECK_INTERVAL_MS;
    this.graceMs = deps.graceMs ?? GOAL_GRACE_MS;
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.check();
    }, this.checkIntervalMs);
    console.log(
      `[GoalWatcher] Started (check every ${this.checkIntervalMs / 1000 / 60}min, grace ${this.graceMs / 1000 / 60}min)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scan tick. Public so tests can drive it deterministically (the interval
   * just calls it). Each dispatch session is evaluated independently and any
   * per-session error is swallowed so one bad session never aborts the tick.
   */
  async check(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;
    try {
      // Snapshot entries first: stop() mutates the live map, so iterating a
      // stable array avoids any iterator-vs-deletion ambiguity mid-tick.
      const sessions = Array.from(this.sessionManager.entries());
      const liveDispatch = new Set<string>();

      for (const [threadId, session] of sessions) {
        const match = session.branch?.match(DISPATCH_BRANCH_RE);
        if (!match) continue; // not a dispatch session (corp / work branch) → AC-6
        liveDispatch.add(threadId);
        try {
          await this.evaluate(threadId, session, Number(match[1]));
        } catch (err) {
          // Fail-soft per session: log and keep scanning the rest.
          console.error(
            `[GoalWatcher] Error evaluating thread ${threadId}:`,
            err
          );
        }
      }

      // Drop grace state for threads that are no longer live dispatch sessions
      // (stopped here or elsewhere) so `pending` cannot leak across ticks.
      for (const threadId of [...this.pending.keys()]) {
        if (!liveDispatch.has(threadId)) this.pending.delete(threadId);
      }
    } finally {
      this.isChecking = false;
    }
  }

  private async evaluate(
    threadId: string,
    session: { branch?: string; lastActivityAt: Date; channelName: string; projectDir: string; worktree?: { mainRepoDir: string } },
    issueNumber: number
  ): Promise<void> {
    const repoDir = session.worktree?.mainRepoDir ?? session.projectDir;
    const labels = await this.fetchIssueLabels(repoDir, issueNumber);

    if (!labels.includes(DONE_LABEL)) {
      // Not done (or `done` was removed) → close any open grace window. Also
      // covers AC-7: a closed-but-not-`done` Issue keeps the session alive.
      this.pending.delete(threadId);
      return;
    }

    const entry = this.pending.get(threadId);
    if (!entry) {
      // First sighting of `done` → open a cancellable grace window (AC-5).
      this.pending.set(threadId, {
        detectedAt: this.now(),
        activityAtDetection: session.lastActivityAt.getTime(),
      });
      return;
    }

    // A thread message since detection means the chairman is still working →
    // cancel the auto-stop (AC-5). Re-opens fresh on the next tick if `done`
    // persists and the thread goes quiet again.
    if (session.lastActivityAt.getTime() > entry.activityAtDetection) {
      this.pending.delete(threadId);
      return;
    }

    if (this.now() - entry.detectedAt >= this.graceMs) {
      await this.stopSession(threadId, session.channelName);
      this.pending.delete(threadId);
    }
  }

  private async stopSession(
    threadId: string,
    channelName: string
  ): Promise<void> {
    console.log(
      `[GoalWatcher] Thread ${threadId} (${channelName}) reached \`done\`; auto-stopping (goal_complete)`
    );
    try {
      await this.sessionManager.stop(threadId, "goal_complete");
    } catch (err) {
      // Leave the thread untouched if the stop itself failed; the next tick (or
      // the 7-day reaper) retries.
      console.error(`[GoalWatcher] Failed to stop ${threadId}:`, err);
      return;
    }
    await this.notifyThread(threadId);
  }

  /**
   * Post a completion notice, mark the title stopped, and archive the thread —
   * the same teardown UX as the Reaper, so a goal-completed thread is visually
   * closed (AC-4: it disappears from `/session list` and is archived).
   */
  private async notifyThread(threadId: string): Promise<void> {
    try {
      const thread = this.client.channels.cache.get(threadId) as
        | ThreadChannel
        | undefined;

      if (thread?.isThread()) {
        await thread.send(
          `✅ ゴール（\`done\` ラベル）到達のためセッションを自動終了しました。`
        );
        const stoppedName = markTitleStopped(thread.name);
        await thread.setName(stoppedName);
        await thread.setArchived(true);
      }
    } catch (err) {
      console.error(`[GoalWatcher] Failed to notify thread ${threadId}:`, err);
    }
  }
}
