import { resolve, basename } from "path";
import { mkdirSync, copyFileSync } from "fs";

/**
 * Persist relayed Discord attachments as project assets (Issue #152).
 *
 * Previously attachments lived only in a tmp dir and were deleted 5 minutes
 * after relay (relay.ts `scheduleCleanup`), so "material screenshots" vanished
 * mid-task and the user had to re-send them. Materials are project assets, not
 * ephemeral relay buffers — copy them into
 * `<projectDir>/.claude/discord-materials/<threadId>/` and hand Claude the
 * persistent path. The tmp copy is still cleaned up by the relay; only the
 * persistent copy survives.
 *
 * No automatic GC runs over the materials dir: these are assets the user
 * explicitly wants kept (deleting them is the very bug this fixes), so
 * unbounded retention is intentional, not an oversight. Re-sending the same
 * filename in a thread overwrites the previous copy (`copyFileSync`). A
 * size/age-based retention policy, if ever needed, is tracked as a follow-up.
 */

const MATERIALS_SUBDIR = ".claude/discord-materials";

/**
 * Reduce a Discord thread id to a path-safe segment. Thread ids are Discord
 * snowflakes (numeric) but treat them as untrusted input: strip anything that
 * is not `[A-Za-z0-9_-]` so a crafted id can never traverse out of the
 * materials dir (RW-045: untrusted input in filesystem paths).
 */
export function sanitizeThreadId(threadId: string): string {
  const cleaned = threadId.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "_";
}

/**
 * Reduce an attachment filename to a path-safe basename: drop any directory
 * component and collapse `..` runs so the copy destination can never escape the
 * materials dir, even if Discord supplied a hostile filename.
 */
export function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[/\\]/g, "").replace(/\.\.+/g, ".");
  return base.length > 0 ? base : "file";
}

/** Absolute path to the persistent materials dir for a given project + thread. */
export function materialsDir(projectDir: string, threadId: string): string {
  return resolve(projectDir, MATERIALS_SUBDIR, sanitizeThreadId(threadId));
}

/**
 * Copy each tmp file into the project's persistent materials dir and return the
 * persistent paths (suitable for handing to Claude's `Read` tool).
 *
 * Defensive / fail-open per file: if the dir cannot be created or a copy fails,
 * the original tmp path is returned for that file (degraded — it is still
 * cleaned up after 5 min) and a warning is logged. Persistence failure must
 * never fail the relay itself.
 */
export function persistAttachments(
  tmpFiles: string[],
  projectDir: string,
  threadId: string
): string[] {
  if (tmpFiles.length === 0) return [];

  const destDir = materialsDir(projectDir, threadId);
  let dirReady = false;
  try {
    mkdirSync(destDir, { recursive: true });
    dirReady = true;
  } catch (err) {
    console.warn(
      `[AttachmentStore] failed to create ${destDir}, keeping tmp paths:`,
      err
    );
  }

  return tmpFiles.map((tmp) => {
    if (!dirReady) return tmp;
    const dest = resolve(destDir, sanitizeFilename(basename(tmp)));
    try {
      copyFileSync(tmp, dest);
      return dest;
    } catch (err) {
      console.warn(
        `[AttachmentStore] failed to copy ${tmp} -> ${dest}, keeping tmp path:`,
        err
      );
      return tmp;
    }
  });
}
