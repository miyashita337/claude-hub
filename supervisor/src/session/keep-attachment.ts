import { resolve, basename, sep } from "path";
import { homedir } from "os";
import {
  statSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from "fs";
import { ATTACHMENT_DIR } from "./gc-attachments";

/**
 * Persistent archive for attachments the user explicitly keeps (Issue #193,
 * /keep — #151 AC-3 follow-up).
 *
 * Files moved here live OUTSIDE {@link ATTACHMENT_DIR}, so the 30-day GC
 * ({@link import("./gc-attachments").gcAttachments}) — which only sweeps
 * ATTACHMENT_DIR — never touches them. "Persisting" is simply relocating a file
 * out of the swept directory; no separate keep-flag, manifest, or bookkeeping
 * is needed (KISS). The archive itself has no TTL: kept material is retained
 * indefinitely until the user removes it manually.
 */
export const ATTACHMENT_ARCHIVE_DIR = resolve(homedir(), "claude-hub-archive");

export interface KeepOptions {
  /** Source directory to take the file from. Defaults to {@link ATTACHMENT_DIR}. */
  sourceDir?: string;
  /** Archive destination. Defaults to {@link ATTACHMENT_ARCHIVE_DIR}. */
  archiveDir?: string;
}

export interface KeepResult {
  /** Absolute path of the archived file. */
  archivedPath: string;
}

/**
 * A keep request that cannot be satisfied (missing / invalid filename). A
 * distinct error type so the command handler can surface a clear user message
 * and never treat a typo as a silent success (journey AC item 3 / RW-023).
 */
export class KeepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeepError";
  }
}

/**
 * Move a single attachment file out of the GC-swept source directory into the
 * persistent archive, so it survives the 30-day TTL.
 *
 * `filename` must be a plain basename of a file directly inside `sourceDir`;
 * path separators and traversal (`..`, `/etc/x`, `a/b`) are rejected so /keep
 * can never reach a file outside the attachments directory. A non-existent
 * target throws {@link KeepError} (never a silent no-op).
 */
export function keepAttachment(
  filename: string,
  options: KeepOptions = {},
): KeepResult {
  const sourceDir = resolve(options.sourceDir ?? ATTACHMENT_DIR);
  const archiveDir = resolve(options.archiveDir ?? ATTACHMENT_ARCHIVE_DIR);

  const name = filename.trim();
  if (!name) {
    throw new KeepError("ファイル名が必須です。");
  }
  // Only a plain basename within sourceDir is allowed. `basename(name) !== name`
  // catches embedded separators (`a/b`); the explicit checks catch `.`/`..` and
  // NUL. This blocks path traversal before any filesystem access.
  if (
    name !== basename(name) ||
    name === "." ||
    name === ".." ||
    name.includes("\0")
  ) {
    throw new KeepError(`不正なファイル名です（パス区切りや '..' は使用できません）: ${filename}`);
  }

  const sourcePath = resolve(sourceDir, name);
  // Defense in depth: the resolved path must stay strictly inside sourceDir.
  if (!sourcePath.startsWith(sourceDir + sep)) {
    throw new KeepError(`不正なファイル名です: ${filename}`);
  }

  let isFile: boolean;
  try {
    isFile = statSync(sourcePath).isFile();
  } catch {
    throw new KeepError(
      `対象が見つかりません: ${filename}（${sourceDir} 配下に存在しません）`,
    );
  }
  if (!isFile) {
    throw new KeepError(`対象がファイルではありません: ${filename}`);
  }

  mkdirSync(archiveDir, { recursive: true });
  const archivedPath = resolve(archiveDir, name);

  // rename is atomic within a filesystem; fall back to copy+unlink when the
  // archive lives on a different device (EXDEV), e.g. an external volume.
  try {
    renameSync(sourcePath, archivedPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EXDEV") {
      copyFileSync(sourcePath, archivedPath);
      unlinkSync(sourcePath);
    } else {
      throw err;
    }
  }

  return { archivedPath };
}
