// Phase 2.6 — Skill autonomous CRUD meta tools.
//
// 4 tools registered into BUILT_IN_TOOLS:
//   create_skill / update_skill — high risk (confirm card)
//   delete_skill / list_skills  — low risk
//
// Each handler enforces 8 capability-grant invariants from the plan
// (docs/plans/2026-05-01-001-feat-skill-autonomous-crud-plan.md):
//
//   P0-A  update_skill rejects builtIn=true targets
//   P0-B  parameters JSON Schema string fields total length ≤ 2 KB
//   P0-C  update_skill taint: author='agent'
//   P0-D  promptTemplate length ≤ 8 KB (paired with confirm-card cap bypass in Unit 7)
//   P1-E  schema additionalProperties:false + handler strips args.id explicitly
//   P1-F  removed (#26 — allowedTools / R2 deleted)
//   P1-G  removed (#26 — allowedTools / R2 deleted)
//   P1-H  total skill_* storage ≤ 1 MB (defense against confirm-fatigue DoS)

import type { ActionResult } from "../../dom-actions/types";
import type { Tool } from "../types";
import type { SkillDefinition } from "../../skills/types";
import {
  saveSkill,
  deleteSkill,
  getSkill,
  generateSkillId,
  getSkillStorageBytes,
} from "../../skills/storage";
import { getAllSkills } from "../../skills";

// ── Configuration / limits ───────────────────────────────────────────────────

const PROMPT_TEMPLATE_MAX_BYTES = 8 * 1024; // P0-D
const SCHEMA_STRINGS_MAX_BYTES = 2 * 1024;  // P0-B
const SKILL_STORAGE_QUOTA_BYTES = 1 * 1024 * 1024; // P1-H — 1 MB; chrome.storage.local total is 5 MB,
                                                   // leaving 4 MB for provider configs / agent state / future checkpoints.

// ── Validation helpers ───────────────────────────────────────────────────────

function err(reason: string): ActionResult {
  return { success: false, error: reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Recursively count the total character length of every string nested anywhere
 * within a JSON-Schema-like object. Used by P0-B schema-string trust-boundary
 * cap. Counts everything including schema keywords ('object', 'array', etc.)
 * for safety — these are short and don't materially shrink the budget.
 */
function countAllStringChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countAllStringChars(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    let total = 0;
    for (const v of Object.values(value as Record<string, unknown>)) {
      total += countAllStringChars(v);
    }
    return total;
  }
  return 0;
}

/**
 * Approximate the bytes a skill will consume in chrome.storage.local. Matches
 * the accounting used by getSkillStorageBytes (JSON.stringify length + key
 * length). Used by the P1-H quota gate.
 */
function estimateSkillBytes(skill: SkillDefinition): number {
  return JSON.stringify(skill).length + `skill_${skill.id}`.length;
}

/** Run all P0-B / P0-D content validations. Returns null when ok,
 *  or an error reason. */
function validateSkillContent(args: {
  promptTemplate: string;
  parameters: unknown;
}): string | null {
  // P0-D
  if (args.promptTemplate.length > PROMPT_TEMPLATE_MAX_BYTES) {
    return `promptTemplate too long (max ${PROMPT_TEMPLATE_MAX_BYTES} bytes, got ${args.promptTemplate.length})`;
  }
  // parameters must be object
  if (typeof args.parameters !== "object" || args.parameters === null || Array.isArray(args.parameters)) {
    return "parameters must be a JSON Schema object";
  }
  // P0-B
  const schemaChars = countAllStringChars(args.parameters);
  if (schemaChars > SCHEMA_STRINGS_MAX_BYTES) {
    return `parameters schema strings too long (max ${SCHEMA_STRINGS_MAX_BYTES} bytes, got ${schemaChars})`;
  }
  return null;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const createSkillTool: Tool = {
  name: "create_skill",
  description:
    "Persist a new reusable workflow as a callable Skill. The skill becomes a tool the agent can later invoke. Use sparingly — only when you recognize the user repeatedly performs a similar workflow. The user must confirm before save.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "promptTemplate", "parameters"],
    properties: {
      name: {
        type: "string",
        description: "Short human-readable label shown in SkillsList.",
      },
      description: {
        type: "string",
        description: "What this skill does and when to use it. Surfaces to the LLM as part of the tool definition.",
      },
      promptTemplate: {
        type: "string",
        description:
          "Handlebars-style template with {{key}} placeholders matching parameters keys. Rendered on each invocation and appended to LLM context as the skill's observation.",
      },
      parameters: {
        type: "object",
        description:
          "JSON Schema for skill invocation parameters: { type: 'object', properties: {...}, required: [...] }.",
      },
    },
  },
  handler: async (args: unknown): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {}) as Record<string, unknown>;
    // P1-E layer 2: even if schema bypass somehow allowed args.id through, strip it.
    delete a.id;

    if (!isNonEmptyString(a.name)) return err("name is required and must be a non-empty string");
    if (!isNonEmptyString(a.description)) return err("description is required and must be a non-empty string");
    if (!isNonEmptyString(a.promptTemplate)) return err("promptTemplate is required and must be a non-empty string");

    const validationErr = validateSkillContent({
      promptTemplate: a.promptTemplate as string,
      parameters: a.parameters,
    });
    if (validationErr) return err(validationErr);

    const skill: SkillDefinition = {
      id: generateSkillId(),
      name: (a.name as string).trim(),
      description: (a.description as string).trim(),
      toolSchema: { parameters: a.parameters as Record<string, unknown> },
      promptTemplate: a.promptTemplate as string,
      enabled: true,
      builtIn: false,
      author: "agent",
      createdAt: Date.now(),
    };

    // P1-H quota
    const currentBytes = await getSkillStorageBytes();
    const additional = estimateSkillBytes(skill);
    if (currentBytes + additional > SKILL_STORAGE_QUOTA_BYTES) {
      return err(
        `skill storage quota exceeded (${currentBytes + additional}/${SKILL_STORAGE_QUOTA_BYTES} bytes). Delete unused skills via delete_skill.`,
      );
    }

    await saveSkill(skill);
    return {
      success: true,
      observation: `skill created: id=${skill.id} name="${skill.name}". Callable on subsequent turns.`,
    };
  },
};

const updateSkillTool: Tool = {
  name: "update_skill",
  description:
    "Modify an existing non-built-in Skill. Only description / promptTemplate / parameters can change. Built-in skills are immutable. Updating any field re-marks the skill as agent-authored.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id", "patch"],
    properties: {
      id: { type: "string", description: "Id of the skill to update." },
      patch: {
        type: "object",
        additionalProperties: false,
        description: "Subset of fields to update. Forbidden fields (id / author / builtIn / createdAt / enabled / firstRunConfirmedAt) are silently ignored if included.",
        properties: {
          description: { type: "string" },
          promptTemplate: { type: "string" },
          parameters: { type: "object" },
        },
      },
    },
  },
  handler: async (args: unknown): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as { id?: unknown; patch?: unknown };
    if (!isNonEmptyString(a.id)) return err("id is required");
    if (typeof a.patch !== "object" || a.patch === null || Array.isArray(a.patch)) {
      return err("patch must be an object");
    }
    const patch = a.patch as Record<string, unknown>;

    const existing = await getSkill(a.id);
    if (!existing) return err("skill not found");

    // P0-A
    if (existing.builtIn) return err("cannot edit built-in skill");

    // Apply allowed patch fields; silently ignore forbidden (id/author/builtIn/createdAt/enabled/firstRunConfirmedAt)
    const merged: SkillDefinition = { ...existing };
    if ("description" in patch) {
      if (!isNonEmptyString(patch.description)) return err("description must be a non-empty string");
      merged.description = (patch.description as string).trim();
    }
    if ("promptTemplate" in patch) {
      if (!isNonEmptyString(patch.promptTemplate)) return err("promptTemplate must be a non-empty string");
      merged.promptTemplate = patch.promptTemplate as string;
    }
    if ("parameters" in patch) {
      merged.toolSchema = { parameters: patch.parameters as Record<string, unknown> };
    }

    // Re-validate full content
    const validationErr = validateSkillContent({
      promptTemplate: merged.promptTemplate,
      parameters: merged.toolSchema.parameters,
    });
    if (validationErr) return err(validationErr);

    // P0-C taint propagation
    merged.author = "agent";

    // P1-H quota — net change, since we're replacing
    const currentBytes = await getSkillStorageBytes();
    const oldBytes = estimateSkillBytes(existing);
    const newBytes = estimateSkillBytes(merged);
    if (currentBytes - oldBytes + newBytes > SKILL_STORAGE_QUOTA_BYTES) {
      return err(`skill storage quota exceeded`);
    }

    await saveSkill(merged);
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
    const a = (args && typeof args === "object" ? args : {}) as { id?: unknown };
    if (!isNonEmptyString(a.id)) return err("id is required");
    const existing = await getSkill(a.id);
    if (!existing) return err("skill not found");
    if (existing.builtIn) return err("cannot delete built-in skill");
    await deleteSkill(a.id);
    return { success: true, observation: `skill deleted: ${a.id}` };
  },
};

const listSkillsTool: Tool = {
  name: "list_skills",
  description:
    "List all available skills with their id, name, description, author (user/agent), and enabled state. Use this before proposing create_skill to check for existing reusable workflows. Does NOT return promptTemplate or parameters (use the returned id with subsequent flows if you need full content).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  handler: async (): Promise<ActionResult> => {
    const all = await getAllSkills();
    const summary = all.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      author: s.author ?? "user",
      builtIn: s.builtIn,
      enabled: s.enabled,
    }));
    return { success: true, observation: JSON.stringify(summary) };
  },
};

// ── Confirm-card preview helper ──────────────────────────────────────────────
//
// Used by the loop dispatcher to pre-compute the effective skill that
// create_skill / update_skill will persist if the user approves. AgentConfirmCard
// renders this so update_skill confirms display the FULL merged skill, not just
// the patch (P0-D + adversarial review adv-1). Best-effort: if args fail
// validation here, the handler will reject after confirm, which is fine —
// the preview is for review only, not authority.

export async function previewMetaSkillCall(
  toolName: string,
  args: unknown,
): Promise<{ existing: SkillDefinition | null; effective: SkillDefinition } | null> {
  if (toolName === "create_skill") {
    const a = (args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {}) as Record<string, unknown>;
    delete a.id;
    if (typeof a.name !== "string" || typeof a.description !== "string" || typeof a.promptTemplate !== "string") return null;
    if (typeof a.parameters !== "object" || a.parameters === null || Array.isArray(a.parameters)) return null;
    const effective: SkillDefinition = {
      // Real id is generated on save; render placeholder to make this explicit.
      id: "(auto-generated on save)",
      name: a.name,
      description: a.description,
      toolSchema: { parameters: a.parameters as Record<string, unknown> },
      promptTemplate: a.promptTemplate,
      enabled: true,
      builtIn: false,
      author: "agent",
      createdAt: Date.now(),
    };
    return { existing: null, effective };
  }
  if (toolName === "update_skill") {
    const a = (args && typeof args === "object" ? args : {}) as { id?: unknown; patch?: unknown };
    if (typeof a.id !== "string") return null;
    const existing = await getSkill(a.id);
    if (!existing) return null;
    const patch = (a.patch && typeof a.patch === "object" && !Array.isArray(a.patch)
      ? (a.patch as Record<string, unknown>)
      : {});
    const merged: SkillDefinition = { ...existing };
    if (typeof patch.description === "string") merged.description = patch.description;
    if (typeof patch.promptTemplate === "string") merged.promptTemplate = patch.promptTemplate;
    if (
      typeof patch.parameters === "object" &&
      patch.parameters !== null &&
      !Array.isArray(patch.parameters)
    ) {
      merged.toolSchema = { parameters: patch.parameters as Record<string, unknown> };
    }
    // Mirror the taint applied by the actual handler so the user sees what
    // will REALLY be persisted (author=agent).
    merged.author = "agent";
    return { existing, effective: merged };
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
