import { resolve } from "path";
import { homedir } from "os";
import { readdirSync, statSync, unlinkSync } from "fs";

/**
 * Directory where Discord attachments are downloaded before being relayed to
 * Claude Code. Owned here (rather than in relay.ts) because this module is the
 * lifecycle authority for the directory: relay.ts writes into it, this module
 * garbage-collects it. Keeping the constant here avoids a circular import
 * (relay.ts → gc-attachments.ts, never the reverse).
 */
export const ATTACHMENT_DIR = resolve(homedir(), "claude-hub", "tmp", "attachments");

/** Default retention: 30 days (Issue #151, 案B). */
export const ATTACHMENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface GcOptions {
  /** Directory to sweep. Defaults to {@link ATTACHMENT_DIR}. */
  dir?: string;
  /** Files older than this (by mtime) are deleted. Defaults to 30 days. */
  maxAgeMs?: number;
  /** Reference "now" in epoch ms. Injected for deterministic tests. */
  now?: number;
}

export interface GcResult {
  /** Absolute paths of files that were deleted. */
  deleted: string[];
  /** Number of files retained (younger than maxAgeMs). */
  kept: number;
}

/**
 * Delete attachment files older than `maxAgeMs` and log a warning for each.
 *
 * Replaces the previous behavior where relay.ts deleted every attachment
 * 5 minutes after a relay completed (Issue #151): material screenshots
 * disappeared between sessions. Files now persist and are swept only by age,
 * so cross-session references keep working until the retention window elapses.
 *
 * Best-effort: a missing directory is treated as "nothing to do", and a
 * per-file delete failure is logged but does not abort the sweep. The warning
 * log on every deletion satisfies the silent-failure guard (AC-4 / RW-023).
 *
 * relay.ts only writes here (names files `${Date.now()}-<name>`); it never
 * deletes. This GC is the sole deleter and decides purely by age, so a freshly
 * written file is safe until the retention window elapses. If a much-older
 * conversation still references a since-GC'd path, that is fail-open: the Read
 * simply fails and Claude reports it — no stale-path bookkeeping is attempted.
 */
export function gcAttachments(options: GcOptions = {}): GcResult {
  const dir = options.dir ?? ATTACHMENT_DIR;
  const maxAgeMs = options.maxAgeMs ?? ATTACHMENT_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const cutoff = now - maxAgeMs;

  const deleted: string[] = [];
  let kept = 0;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // Directory not yet created (no attachment ever received) is normal.
    if (e.code !== "ENOENT") {
      console.warn(`[gc-attachments] cannot read ${dir}: ${e.code ?? err}`);
    }
    return { deleted, kept };
  }

  for (const name of entries) {
    const filePath = resolve(dir, name);
    let mtimeMs: number;
    try {
      const st = statSync(filePath);
      if (!st.isFile()) continue;
      mtimeMs = st.mtimeMs;
    } catch (err) {
      console.warn(`[gc-attachments] cannot stat ${filePath}: ${err}`);
      continue;
    }

    if (mtimeMs < cutoff) {
      try {
        unlinkSync(filePath);
        const ageDays = Math.floor((now - mtimeMs) / (24 * 60 * 60 * 1000));
        console.warn(`[gc-attachments] deleted ${filePath} (age ${ageDays}d)`);
        deleted.push(filePath);
      } catch (err) {
        console.warn(`[gc-attachments] failed to delete ${filePath}: ${err}`);
      }
    } else {
      kept++;
    }
  }

  return { deleted, kept };
}

// CLI entry: `bun run src/session/gc-attachments.ts`. Run by the
// com.claude-hub.gc-attachments launchd job (daily).
if (import.meta.main) {
  const result = gcAttachments();
  console.log(
    `[gc-attachments] done: ${result.deleted.length} deleted, ${result.kept} kept`
  );
}
