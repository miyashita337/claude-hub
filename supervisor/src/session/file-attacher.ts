import { statSync } from "fs";
import { isAbsolute, resolve } from "path";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB (Discord default upload limit)
const MAX_FILES = 10; // Discord per-message attachment cap
const EXTENSIONS = [
  "md", "txt", "json", "csv", "html", "log",
  "yaml", "yml", "png", "jpg", "jpeg", "gif",
  "pdf", "svg", "webp",
];

const EXT_PATTERN = EXTENSIONS.join("|");
// Match path-like tokens ending in a whitelisted extension.
// Allows letters, digits, underscore, hyphen, dot, slash, and common Japanese/Unicode
// characters in filenames (everything except whitespace and a few delimiters).
const PATH_REGEX = new RegExp(
  `(?:\\.{1,2}/|/)?[^\\s\`"'<>()\\[\\]|]+?\\.(?:${EXT_PATTERN})\\b`,
  "gi"
);

export interface AttachableFile {
  absPath: string;
  displayName: string;
  size: number;
}

export interface CollectResult {
  files: AttachableFile[];
  oversizeWarnings: string[];
}

/**
 * Extract file-path-like tokens from Claude Code response text.
 * Returns unique path strings (not resolved).
 */
export function extractFilePaths(text: string): string[] {
  const matches = text.match(PATH_REGEX) ?? [];
  // Strip trailing punctuation that regex may have greedily captured
  const cleaned = matches.map((p) => p.replace(/[.,;:)]+$/, ""));
  return Array.from(new Set(cleaned));
}

/**
 * Resolve paths against the session's project directory and collect
 * those that exist and are attachable (≤ 8MB, ≤ 10 files).
 */
export function collectAttachableFiles(
  paths: string[],
  projectDir: string
): CollectResult {
  const files: AttachableFile[] = [];
  const oversizeWarnings: string[] = [];
  const seen = new Set<string>();

  for (const p of paths) {
    if (files.length >= MAX_FILES) break;

    const abs = isAbsolute(p) ? p : resolve(projectDir, p);
    if (seen.has(abs)) continue;
    seen.add(abs);

    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue; // does not exist
    }
    if (!stat.isFile()) continue;

    if (stat.size > MAX_FILE_SIZE) {
      const mb = (stat.size / (1024 * 1024)).toFixed(2);
      oversizeWarnings.push(`⚠️ \`${p}\` は大きすぎて添付できません (${mb}MB)`);
      continue;
    }

    files.push({
      absPath: abs,
      displayName: abs.split("/").pop() ?? "file",
      size: stat.size,
    });
  }

  return { files, oversizeWarnings };
}
