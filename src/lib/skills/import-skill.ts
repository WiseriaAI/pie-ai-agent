// src/lib/skills/import-skill.ts
//
// Pure core for the SkillsList "import external skill folder" entry (#321).
// The browser hands us a flat list of the selected folder's files (via a
// <input type="file" webkitdirectory>); this module validates that list
// (fail-closed — the folder is untrusted external input) and turns it into a
// write plan the panel feeds to writeSkillRpc. No DOM / File APIs here so the
// validation + path rules stay unit-testable; the File→ImportRawFile decoding
// adapter lives in the component.

import type { SkillWriteFile } from "./source";
import { parseSkillMarkdown } from "./frontmatter";

/** Upper bounds guard against accidentally selecting a huge directory. */
export const IMPORT_MAX_FILES = 200;
export const IMPORT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/**
 * Skill id = top-level folder name = on-disk directory name. Aligns with the
 * daemon's assertSkillName (kebab-case) so an import lands identically in both
 * the IDB and the daemon-disk backend.
 */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ImportRawFile {
  /** webkitRelativePath — includes the top-level folder segment, e.g. "my-skill/SKILL.md". */
  relPath: string;
  size: number;
  /** Decoded UTF-8 text, or null when the file was detected as binary (skipped from the write). */
  content: string | null;
}

export interface ImportPlan {
  id: string;
  name: string;
  description: string;
  /** Text files relative to the skill root (top folder stripped) — the writeSkillRpc payload. */
  files: SkillWriteFile[];
  /** Binary files skipped from the write, relative to the skill root — surfaced in the confirm UI. */
  skippedBinary: string[];
  /** True when the folder carries a scripts/ directory (drives the auth-card / daemon hint). */
  hasScripts: boolean;
}

/** Coded errors — the component maps each to a localized message (optionally with `detail`). */
export type ImportErrorCode =
  | "empty"
  | "too-many-files"
  | "too-large"
  | "multiple-roots"
  | "invalid-id"
  | "unsafe-path"
  | "missing-skill-md"
  | "invalid-frontmatter";

export type ImportPlanResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; error: ImportErrorCode; detail?: string };

/**
 * Validate a selected folder's raw file list and build a write plan.
 *
 * Caps are checked against the RAW selection (before any skip filtering) so a
 * mis-selected large directory is rejected up front. Path safety is fail-closed:
 * any traversal / absolute / empty segment aborts the whole import (no partial
 * write). `.git` / `node_modules` / dotfiles are silently skipped, not errored.
 */
export function buildImportPlan(raw: ImportRawFile[]): ImportPlanResult {
  if (raw.length === 0) return { ok: false, error: "empty" };

  if (raw.length > IMPORT_MAX_FILES) return { ok: false, error: "too-many-files" };
  const totalBytes = raw.reduce((n, f) => n + (f.size > 0 ? f.size : 0), 0);
  if (totalBytes > IMPORT_MAX_TOTAL_BYTES) return { ok: false, error: "too-large" };

  // Top-level folder = id. webkitdirectory always yields a single root, but
  // guard against mixed roots defensively.
  const roots = new Set<string>();
  for (const f of raw) roots.add(f.relPath.split("/")[0]);
  if (roots.size !== 1) return { ok: false, error: "multiple-roots" };
  const id = [...roots][0];
  if (!SKILL_ID_RE.test(id)) return { ok: false, error: "invalid-id", detail: id };

  const files: SkillWriteFile[] = [];
  const skippedBinary: string[] = [];
  let hasScripts = false;

  for (const f of raw) {
    const segments = f.relPath.split("/");
    const relSegments = segments.slice(1);
    const rel = relSegments.join("/");
    if (rel === "") continue; // the top-level directory entry itself (no filename)

    // Fail-closed path safety FIRST — reject traversal / absolute / empty
    // segments before the dotfile skip (".." also starts with ".", but must
    // error rather than be silently dropped).
    if (relSegments.some((s) => s === "" || s === "." || s === "..") || rel.startsWith("/")) {
      return { ok: false, error: "unsafe-path", detail: f.relPath };
    }

    // Skip dotfiles/dirs and node_modules — not part of the skill package.
    if (relSegments.some((s) => s.startsWith(".") || s === "node_modules")) continue;

    if (relSegments[0] === "scripts") hasScripts = true;

    if (f.content === null) skippedBinary.push(rel);
    else files.push({ path: rel, content: f.content });
  }

  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) return { ok: false, error: "missing-skill-md" };

  let name: string;
  let description: string;
  try {
    const { frontmatter } = parseSkillMarkdown(skillMd.content);
    name = frontmatter.name;
    description = frontmatter.description;
  } catch (e) {
    return {
      ok: false,
      error: "invalid-frontmatter",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  return { ok: true, plan: { id, name, description, files, skippedBinary, hasScripts } };
}
