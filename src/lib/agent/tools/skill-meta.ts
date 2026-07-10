// Phase 2.6 — Skill autonomous CRUD meta tools (SP-1 rewrite).
// Task 6 — dual-mode rewrite: these 4 tools now operate through the
// SkillSource abstraction (src/lib/skills/source.ts), so they work against
// IndexedDB (idb mode) or the on-disk `~/.pie/skills` daemon bridge (disk
// mode) without branching call sites elsewhere.
//
// 4 tools registered into BUILT_IN_TOOLS:
//   create_skill / update_skill — persist new capabilities as Skills
//   delete_skill / list_skills  — read / reduce capabilities
//
// Security defenses preserved from the original implementation:
//
//   P0-A  update_skill / delete_skill reject builtIn=true packages
//   P0-C  update_skill taint: author='agent' (stored in SKILL.md frontmatter)
//   P0-D  instructions (SKILL.md body) length ≤ 8 KB  [formerly promptTemplate cap]
//   P1-E  schema additionalProperties:false + handler strips args.id explicitly
//   P1-H  total IndexedDB package bytes ≤ 1 MB  [idb mode only — disk has no
//         quota semantics; the daemon bridge writes straight to disk]
//
// P0-B (parameters schema strings ≤ 2 KB) was removed: the new model has no
// typed parameters / JSON Schema field — instructions are free-form markdown
// in SKILL.md. The instructions cap (P0-D, 8 KB) is the effective content guard.

import type { ActionResult } from "../../dom-actions/types";
import type { Tool } from "../types";
import type { SkillPackage } from "../../skills/package-types";
import type { SkillSource } from "../../skills/source";
import { stripFrontmatter, kebabSlug } from "../../skills/source";
import { getAllSkillPackages, resolveSkillPackage } from "../../skills";
import { setSkillEnabled, generateSkillId } from "../../skills/storage";
import { buildSkillMd, isSingleLineSafe } from "../../skills/skill-md";
import { getActiveSkillSource } from "@/background/skill-source";

// ── Configuration / limits ───────────────────────────────────────────────────

const INSTRUCTIONS_MAX_BYTES = 8 * 1024; // P0-D — SKILL.md body (instructions)
const SKILL_STORAGE_QUOTA_BYTES = 1 * 1024 * 1024; // P1-H — 1 MB total IndexedDB packages (idb mode only)

// ── Validation helpers ───────────────────────────────────────────────────────

function err(reason: string): ActionResult {
  return { success: false, error: reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Approximate the bytes a SkillPackage will consume in IndexedDB.
 * Uses JSON.stringify length + key length as a consistent estimator. Used by
 * the P1-H quota gate. idb mode only.
 */
function estimatePackageBytes(pkg: SkillPackage): number {
  return JSON.stringify(pkg).length + pkg.id.length;
}

/**
 * Compute total bytes currently used by all packages in IndexedDB.
 * P1-H quota gate implementation. idb mode only — disk backends have no byte
 * quota semantics, so callers must not invoke this outside `mode === "idb"`.
 */
async function getPackageStorageBytes(): Promise<number> {
  const pkgs = await getAllSkillPackages();
  return pkgs.reduce((sum, p) => sum + estimatePackageBytes(p), 0);
}

export interface SkillMetaDeps {
  getSource: () => SkillSource;
}

export function buildSkillMetaTools(deps: SkillMetaDeps): Tool[] {
  // ── Tool definitions ───────────────────────────────────────────────────────

  const createSkillTool: Tool = {
    name: "create_skill",
    description:
      "Persist a new reusable workflow as a callable Skill. The skill becomes available to invoke via use_skill. Use sparingly — only when you recognize the user repeatedly performs a similar workflow.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "instructions"],
      properties: {
        name: {
          type: "string",
          description: "Short human-readable label shown in SkillsList.",
        },
        description: {
          type: "string",
          description:
            "What this skill does and when to use it. Surfaces to the LLM as part of the skill listing.",
        },
        instructions: {
          type: "string",
          description:
            "Free-form step-by-step instructions that become the SKILL.md body. Max 8 KB. Written in plain text or markdown.",
        },
      },
    },
    handler: async (args: unknown): Promise<ActionResult> => {
      const a = (
        args && typeof args === "object"
          ? { ...(args as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      // P1-E layer 2: even if schema bypass somehow allowed args.id through, strip it.
      delete a.id;

      if (!isNonEmptyString(a.name))
        return err("name is required and must be a non-empty string");
      if (!isNonEmptyString(a.description))
        return err("description is required and must be a non-empty string");
      if (!isNonEmptyString(a.instructions))
        return err("instructions is required and must be a non-empty string");

      // Frontmatter-injection guard
      if (!isSingleLineSafe(a.name as string) || !isSingleLineSafe(a.description as string)) {
        return err("name/description must be single-line (no newlines or '---')");
      }

      const instructions = a.instructions as string;

      // P0-D — instructions length cap
      if (instructions.length > INSTRUCTIONS_MAX_BYTES) {
        return err(
          `instructions too long (max ${INSTRUCTIONS_MAX_BYTES} bytes, got ${instructions.length})`,
        );
      }

      const name = (a.name as string).trim();
      const description = (a.description as string).trim();
      const source = deps.getSource();
      const md = buildSkillMd(name, description, "1.0.0", "agent", instructions);

      if (source.mode === "idb") {
        const id = generateSkillId(); // P1-E: always server-generated, agent cannot pass its own id

        // P1-H quota — check before writing (idb-only semantics)
        const pkg: SkillPackage = {
          id,
          frontmatter: { name, description, version: "1.0.0", author: "agent" },
          files: { "SKILL.md": md },
          builtIn: false,
          createdAt: Date.now(),
        };
        const currentBytes = await getPackageStorageBytes();
        const additional = estimatePackageBytes(pkg);
        if (currentBytes + additional > SKILL_STORAGE_QUOTA_BYTES) {
          return err(
            `skill storage quota exceeded (${currentBytes + additional}/${SKILL_STORAGE_QUOTA_BYTES} bytes). Delete unused skills via delete_skill.`,
          );
        }

        await source.write(id, [{ path: "SKILL.md", content: md }]);
        await setSkillEnabled(id, true);
        return {
          success: true,
          observation: `skill created: id=${id} name="${name}". Callable on subsequent turns via use_skill.`,
        };
      }

      // Disk mode — id is a directory-safe slug of the name; no quota, no
      // enabled-marker (on-disk skills default enabled — see filterEnabled).
      let id = kebabSlug(name);
      if (!id) id = `skill-${crypto.randomUUID().slice(0, 8)}`;
      const existingEntries = await source.list();
      if (existingEntries.some((e) => e.id === id)) {
        return err(`skill name already exists: ${id}`);
      }

      await source.write(id, [{ path: "SKILL.md", content: md }]);
      return {
        success: true,
        observation: `skill created: id=${id} name="${name}". Callable on subsequent turns via use_skill.`,
      };
    },
  };

  const updateSkillTool: Tool = {
    name: "update_skill",
    description:
      "Modify an existing non-built-in Skill. Only name, description, and instructions can change. Built-in skills are immutable. Updating any field re-marks the skill as agent-authored.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "Id of the skill to update." },
        name: { type: "string", description: "New name for the skill." },
        description: { type: "string", description: "New description for the skill." },
        instructions: {
          type: "string",
          description: "New instructions (SKILL.md body). Max 8 KB.",
        },
      },
    },
    handler: async (args: unknown): Promise<ActionResult> => {
      const a = (
        args && typeof args === "object" ? args : {}
      ) as { id?: unknown; name?: unknown; description?: unknown; instructions?: unknown };

      if (!isNonEmptyString(a.id)) return err("id is required");
      const id = a.id as string;

      const source = deps.getSource();
      const entries = await source.list();
      const entry = entries.find((e) => e.id === id);
      if (!entry) return err("skill not found");

      // P0-A — builtIn guard. The merged list is required here so a builtin id
      // resolves to its entry and this guard fires, rather than reporting a
      // misleading "skill not found".
      if (entry.builtIn) return err("cannot edit built-in skill");

      // Apply optional patch fields
      let name = entry.name;
      let description = entry.description;

      // Extract current instructions from SKILL.md body (fence-stripped; works
      // identically for idb-produced and disk-authored SKILL.md alike).
      const currentMd = (await source.readFile(id, "SKILL.md")) ?? "";
      let instructions = stripFrontmatter(currentMd);

      if ("name" in (a as Record<string, unknown>)) {
        if (!isNonEmptyString(a.name)) return err("name must be a non-empty string");
        name = (a.name as string).trim();
      }
      if ("description" in (a as Record<string, unknown>)) {
        if (!isNonEmptyString(a.description))
          return err("description must be a non-empty string");
        description = (a.description as string).trim();
      }
      if ("instructions" in (a as Record<string, unknown>)) {
        if (!isNonEmptyString(a.instructions))
          return err("instructions must be a non-empty string");
        instructions = a.instructions as string;
      }

      // Frontmatter-injection guard
      if (!isSingleLineSafe(name) || !isSingleLineSafe(description)) {
        return err("name/description must be single-line (no newlines or '---')");
      }

      // P0-D — instructions length cap
      if (instructions.length > INSTRUCTIONS_MAX_BYTES) {
        return err(
          `instructions too long (max ${INSTRUCTIONS_MAX_BYTES} bytes, got ${instructions.length})`,
        );
      }

      // P0-C taint propagation
      const md = buildSkillMd(name, description, "1.0.0", "agent", instructions);

      // P1-H quota — net change (idb mode only; disk has no quota semantics)
      if (source.mode === "idb") {
        const existingPkg = await resolveSkillPackage(id);
        if (existingPkg) {
          const mergedPkg: SkillPackage = {
            ...existingPkg,
            frontmatter: { ...existingPkg.frontmatter, name, description, author: "agent" },
            files: { ...existingPkg.files, "SKILL.md": md },
          };
          const currentBytes = await getPackageStorageBytes();
          const oldBytes = estimatePackageBytes(existingPkg);
          const newBytes = estimatePackageBytes(mergedPkg);
          if (currentBytes - oldBytes + newBytes > SKILL_STORAGE_QUOTA_BYTES) {
            return err("skill storage quota exceeded");
          }
        }
      }

      await source.write(id, [{ path: "SKILL.md", content: md }]);

      let observation = `skill updated: id=${id}. author marked 'agent'.`;
      if (source.mode === "disk" && "name" in (a as Record<string, unknown>)) {
        observation += ` note: on-disk directory name (id) is unchanged`;
      }
      return { success: true, observation };
    },
  };

  const deleteSkillTool: Tool = {
    name: "delete_skill",
    description:
      "Delete a non-built-in Skill. Built-in skills cannot be deleted; the user can disable them via SkillsList instead.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
      },
    },
    handler: async (args: unknown): Promise<ActionResult> => {
      const a = (args && typeof args === "object" ? args : {}) as {
        id?: unknown;
      };
      if (!isNonEmptyString(a.id)) return err("id is required");
      const id = a.id as string;

      const source = deps.getSource();
      const entries = await source.list();
      const entry = entries.find((e) => e.id === id);
      if (!entry) return err("skill not found");

      // P0-A — builtIn guard (merged-list lookup so builtin ids hit this guard)
      if (entry.builtIn) return err("cannot delete built-in skill");

      await source.delete(id);
      // Clean up enabled-list entry so the deleted skill doesn't linger in
      // state (both modes — prevents a stale plain-marker surviving a delete).
      await setSkillEnabled(id, false);

      return { success: true, observation: `skill deleted: ${id}` };
    },
  };

  const listSkillsTool: Tool = {
    name: "list_skills",
    description:
      "List all available skills with their id, name, description, author, and builtIn flag. Use this before proposing create_skill to check for existing reusable workflows.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    handler: async (): Promise<ActionResult> => {
      const source = deps.getSource();
      const all = await source.list();
      const summary = all.map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        author: e.author ?? "user",
        builtIn: e.builtIn,
      }));
      return { success: true, observation: JSON.stringify(summary) };
    },
  };

  return [createSkillTool, updateSkillTool, deleteSkillTool, listSkillsTool];
}

// ── Public exports ───────────────────────────────────────────────────────────

export const SKILL_META_TOOLS: Tool[] = buildSkillMetaTools({
  getSource: getActiveSkillSource,
});

export const SKILL_META_TOOL_NAMES = [
  "create_skill",
  "update_skill",
  "delete_skill",
  "list_skills",
] as const;

export type SkillMetaToolName = (typeof SKILL_META_TOOL_NAMES)[number];

export function isSkillMetaToolName(name: string): name is SkillMetaToolName {
  return (SKILL_META_TOOL_NAMES as readonly string[]).includes(name);
}
