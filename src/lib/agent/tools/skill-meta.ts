// Phase 2.6 — Skill autonomous CRUD meta tools (SP-1 rewrite).
//
// 4 tools registered into BUILT_IN_TOOLS:
//   create_skill / update_skill — persist new capabilities as SkillPackages
//   delete_skill / list_skills  — read / reduce capabilities
//
// Security defenses preserved from the original implementation:
//
//   P0-A  update_skill / delete_skill reject builtIn=true packages
//   P0-C  update_skill taint: author='agent' (stored in SKILL.md frontmatter)
//   P0-D  instructions (SKILL.md body) length ≤ 8 KB  [formerly promptTemplate cap]
//   P1-E  schema additionalProperties:false + handler strips args.id explicitly
//   P1-H  total IndexedDB package bytes ≤ 1 MB  [quota gate re-implemented over listPackages()]
//
// P0-B (parameters schema strings ≤ 2 KB) was removed: the new model has no
// typed parameters / JSON Schema field — instructions are free-form markdown
// in SKILL.md. The instructions cap (P0-D, 8 KB) is the effective content guard.

import type { ActionResult } from "../../dom-actions/types";
import type { Tool } from "../types";
import type { SkillPackage } from "../../skills/package-types";
import {
  getAllSkillPackages,
  putPackage,
  getPackage,
  deletePackage,
} from "../../skills";
import {
  generateSkillId,
  setSkillEnabled,
} from "../../skills/storage";

// ── Configuration / limits ───────────────────────────────────────────────────

const INSTRUCTIONS_MAX_BYTES = 8 * 1024; // P0-D — SKILL.md body (instructions)
const SKILL_STORAGE_QUOTA_BYTES = 1 * 1024 * 1024; // P1-H — 1 MB total IndexedDB packages

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
 * the P1-H quota gate.
 */
function estimatePackageBytes(pkg: SkillPackage): number {
  return JSON.stringify(pkg).length + pkg.id.length;
}

/**
 * Compute total bytes currently used by all packages in IndexedDB.
 * P1-H quota gate implementation for the new SkillPackage storage model.
 */
async function getPackageStorageBytes(): Promise<number> {
  const pkgs = await getAllSkillPackages();
  return pkgs.reduce((sum, p) => sum + estimatePackageBytes(p), 0);
}

/**
 * Build a SKILL.md string with YAML frontmatter from the given fields and body.
 */
function buildSkillMd(
  name: string,
  description: string,
  version: string,
  author: string,
  instructions: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\nauthor: ${author}\n---\n${instructions}`;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

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

    const instructions = a.instructions as string;

    // P0-D — instructions length cap
    if (instructions.length > INSTRUCTIONS_MAX_BYTES) {
      return err(
        `instructions too long (max ${INSTRUCTIONS_MAX_BYTES} bytes, got ${instructions.length})`,
      );
    }

    const name = (a.name as string).trim();
    const description = (a.description as string).trim();
    const id = generateSkillId(); // P1-E: always server-generated, agent cannot pass its own id

    const md = buildSkillMd(name, description, "1.0.0", "agent", instructions);

    const pkg: SkillPackage = {
      id,
      frontmatter: { name, description, version: "1.0.0", author: "agent" },
      files: { "SKILL.md": md },
      builtIn: false,
      createdAt: Date.now(),
    };

    // P1-H quota — check before writing
    const currentBytes = await getPackageStorageBytes();
    const additional = estimatePackageBytes(pkg);
    if (currentBytes + additional > SKILL_STORAGE_QUOTA_BYTES) {
      return err(
        `skill storage quota exceeded (${currentBytes + additional}/${SKILL_STORAGE_QUOTA_BYTES} bytes). Delete unused skills via delete_skill.`,
      );
    }

    await putPackage(pkg);
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

    const existing = await getPackage(a.id as string);
    if (!existing) return err("skill not found");

    // P0-A — builtIn guard
    if (existing.builtIn) return err("cannot edit built-in skill");

    // Apply optional patch fields
    let name = existing.frontmatter.name;
    let description = existing.frontmatter.description;

    // Extract current instructions from SKILL.md body
    const currentMd = existing.files["SKILL.md"] ?? "";
    const fenceEnd = currentMd.indexOf("\n---\n");
    let instructions =
      fenceEnd >= 0 ? currentMd.slice(fenceEnd + 5) : currentMd;

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

    // P0-D — instructions length cap
    if (instructions.length > INSTRUCTIONS_MAX_BYTES) {
      return err(
        `instructions too long (max ${INSTRUCTIONS_MAX_BYTES} bytes, got ${instructions.length})`,
      );
    }

    // P0-C taint propagation
    const md = buildSkillMd(name, description, "1.0.0", "agent", instructions);

    const merged: SkillPackage = {
      ...existing,
      frontmatter: { ...existing.frontmatter, name, description, author: "agent" },
      files: { ...existing.files, "SKILL.md": md },
    };

    // P1-H quota — net change (replacing existing, so subtract old size)
    const currentBytes = await getPackageStorageBytes();
    const oldBytes = estimatePackageBytes(existing);
    const newBytes = estimatePackageBytes(merged);
    if (currentBytes - oldBytes + newBytes > SKILL_STORAGE_QUOTA_BYTES) {
      return err("skill storage quota exceeded");
    }

    await putPackage(merged);
    return {
      success: true,
      observation: `skill updated: id=${merged.id}. author marked 'agent'.`,
    };
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

    const existing = await getPackage(a.id as string);
    if (!existing) return err("skill not found");

    // P0-A — builtIn guard
    if (existing.builtIn) return err("cannot delete built-in skill");

    await deletePackage(a.id as string);
    // Clean up enabled-list entry so the deleted skill doesn't linger in state
    await setSkillEnabled(a.id as string, false);

    return { success: true, observation: `skill deleted: ${a.id}` };
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
    const all = await getAllSkillPackages();
    const summary = all.map((p) => ({
      id: p.id,
      name: p.frontmatter.name,
      description: p.frontmatter.description,
      author: p.frontmatter.author ?? "user",
      builtIn: p.builtIn,
    }));
    return { success: true, observation: JSON.stringify(summary) };
  },
};

// ── Confirm-card preview helper ──────────────────────────────────────────────
//
// Used by the loop dispatcher to pre-compute the effective skill that
// create_skill / update_skill will persist. Best-effort: if args fail
// validation here, the handler will reject, which is fine —
// the preview is for review only, not authority.

export async function previewMetaSkillCall(
  toolName: string,
  args: unknown,
): Promise<{ existing: SkillPackage | null; effective: SkillPackage } | null> {
  if (toolName === "create_skill") {
    const a = (
      args && typeof args === "object"
        ? { ...(args as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    delete a.id;
    if (
      typeof a.name !== "string" ||
      typeof a.description !== "string" ||
      typeof a.instructions !== "string"
    )
      return null;
    const name = (a.name as string).trim();
    const description = (a.description as string).trim();
    const instructions = a.instructions as string;
    const md = buildSkillMd(name, description, "1.0.0", "agent", instructions);
    const effective: SkillPackage = {
      id: "(auto-generated on save)",
      frontmatter: { name, description, version: "1.0.0", author: "agent" },
      files: { "SKILL.md": md },
      builtIn: false,
      createdAt: Date.now(),
    };
    return { existing: null, effective };
  }
  if (toolName === "update_skill") {
    const a = (args && typeof args === "object" ? args : {}) as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      instructions?: unknown;
    };
    if (typeof a.id !== "string") return null;
    const existing = await getPackage(a.id);
    if (!existing) return null;

    let name = existing.frontmatter.name;
    let description = existing.frontmatter.description;
    const currentMd = existing.files["SKILL.md"] ?? "";
    const fenceEnd = currentMd.indexOf("\n---\n");
    let instructions =
      fenceEnd >= 0 ? currentMd.slice(fenceEnd + 5) : currentMd;

    if (typeof a.name === "string" && a.name.trim()) name = a.name.trim();
    if (typeof a.description === "string" && a.description.trim())
      description = a.description.trim();
    if (typeof a.instructions === "string" && a.instructions.trim())
      instructions = a.instructions;

    const md = buildSkillMd(name, description, "1.0.0", "agent", instructions);
    const effective: SkillPackage = {
      ...existing,
      frontmatter: { ...existing.frontmatter, name, description, author: "agent" },
      files: { ...existing.files, "SKILL.md": md },
    };
    return { existing, effective };
  }
  return null;
}

// ── Public exports ───────────────────────────────────────────────────────────

export const SKILL_META_TOOLS: Tool[] = [
  createSkillTool,
  updateSkillTool,
  deleteSkillTool,
  listSkillsTool,
];

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
