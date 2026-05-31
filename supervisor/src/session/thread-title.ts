/**
 * Session thread-title formatting (Issue #175).
 *
 * Titles use a branch-based scheme so each session is identifiable at a glance:
 *
 *   {emoji} {branch} · {displayName}            (single same-branch session)
 *   {emoji} {branch} · {displayName} (N)        (Nth concurrent same-branch one)
 *   {emoji} {displayName}                        (no branch — e.g. resume of a
 *                                                 pre-migration session)
 *
 * The branch is untrusted Discord input. Discord renders thread names (never
 * executes them), so there is no injection vector here, but a right-to-left
 * override (U+202E) or zero-width character could visually spoof a title — so
 * those are stripped before the branch reaches the title. Shell safety of the
 * branch (for the worktree path) is enforced separately in worktree.ts.
 */

export type ThreadTitleStatus = "running" | "resume" | "stopped";

const STATUS_EMOJI: Record<ThreadTitleStatus, string> = {
  running: "🟢",
  resume: "♻️",
  stopped: "🔴",
};

// Discord caps thread names at 100 characters; discord.js validates with the
// UTF-16 `.length`, so we measure and truncate against that same unit.
const MAX_TITLE_LEN = 100;
const ELLIPSIS = "…";

/**
 * Remove characters that are dangerous to *display* in a thread title: C0/C1
 * control chars, DEL, bidi overrides/embeddings/isolates, and zero-width
 * characters. Ordinary branch characters — including `/` — are kept.
 */
export function sanitizeBranchForTitle(branch: string): string {
  let out = "";
  for (const ch of branch) {
    const code = ch.codePointAt(0)!;
    const dangerous =
      code <= 0x1f || // C0 controls (incl. tab/newline/CR)
      code === 0x7f || // DEL
      (code >= 0x80 && code <= 0x9f) || // C1 controls
      (code >= 0x200b && code <= 0x200f) || // zero-width + LRM/RLM
      (code >= 0x202a && code <= 0x202e) || // bidi embeddings/overrides
      (code >= 0x2066 && code <= 0x2069) || // bidi isolates
      code === 0xfeff; // BOM / zero-width no-break space
    if (!dangerous) out += ch;
  }
  return out;
}

/** Hard-truncate by UTF-16 length without splitting a surrogate pair. */
function truncateWhole(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = [...s];
  let out = "";
  for (const ch of chars) {
    if ((out + ch).length > max) break;
    out += ch;
  }
  return out;
}

/**
 * Drop characters from the middle of `s` until it fits in `max` UTF-16 units,
 * leaving an ellipsis to mark the cut. Both ends of the branch carry identifying
 * information (prefix like `feat/123-`, suffix like the feature name), so centre
 * truncation preserves more signal than head/tail truncation.
 */
function centreTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= ELLIPSIS.length) return truncateWhole(ELLIPSIS, max);
  const chars = [...s];
  let head = Math.ceil(chars.length / 2); // bias the kept half to the prefix
  let tail = chars.length - head;
  while (head + tail > 0) {
    const candidate =
      chars.slice(0, head).join("") +
      ELLIPSIS +
      chars.slice(chars.length - tail).join("");
    if (candidate.length <= max) return candidate;
    // Shrink the larger half; Math.max keeps the index non-negative even though
    // the loop guard already prevents the negative path.
    if (head >= tail) head = Math.max(0, head - 1);
    else tail = Math.max(0, tail - 1);
  }
  return ELLIPSIS;
}

/**
 * Build a session thread title. `seq` is the 1-based position among concurrent
 * same-branch sessions; only `seq > 1` gets a `(N)` suffix.
 */
export function buildThreadTitle(
  status: ThreadTitleStatus,
  branch: string | null | undefined,
  displayName: string,
  seq: number
): string {
  const emoji = STATUS_EMOJI[status];
  const suffix = seq > 1 ? ` (${seq})` : "";
  const cleaned = branch ? sanitizeBranchForTitle(branch) : "";

  if (!cleaned) {
    // No usable branch: fall back to the legacy display-name-only title.
    return truncateWhole(`${emoji} ${displayName}${suffix}`, MAX_TITLE_LEN);
  }

  const prefix = `${emoji} `;
  const middle = ` · ${displayName}${suffix}`;
  const budget = MAX_TITLE_LEN - prefix.length - middle.length;
  if (budget <= 0) {
    // The display name + suffix already fill the title; there is no room for the
    // branch. Fall back to the display-name-only form (no dangling " · " or
    // double space) and let the final guard trim it to length.
    return truncateWhole(`${emoji} ${displayName}${suffix}`, MAX_TITLE_LEN);
  }
  const branchPart = centreTruncate(cleaned, budget);
  return truncateWhole(`${prefix}${branchPart}${middle}`, MAX_TITLE_LEN);
}

/**
 * Rewrite a live title to its stopped form by swapping the leading status emoji
 * to 🔴. Handles both 🟢 (running) and ♻️ (resume) — the latter fixes the
 * reaper.ts bug where resumed threads kept their ♻️ after being reaped.
 */
export function markTitleStopped(currentName: string): string {
  return currentName
    .replace(STATUS_EMOJI.running, STATUS_EMOJI.stopped)
    .replace(STATUS_EMOJI.resume, STATUS_EMOJI.stopped);
}
