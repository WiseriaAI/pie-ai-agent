export type SkillId = string;

export type SkillAuthor = "user" | "agent";

/**
 * @deprecated since SP-1 (2026-05-21). The old chrome.storage SkillDefinition
 * model has been superseded by SkillPackage (IndexedDB). This interface is
 * kept only so that historical migration code (migration-packages.ts) and
 * back-compat deserialization paths can reference the shape without a local
 * re-definition. No new code should use SkillDefinition.
 */
export interface SkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  /** @deprecated tool parameters schema — superseded by SKILL.md free-form instructions. */
  toolSchema?: {
    parameters: Record<string, unknown>;
  };
  /** @deprecated Handlebars prompt template — superseded by SKILL.md body. */
  promptTemplate?: string;
  /** Whether this skill is currently enabled (legacy; now tracked via enabled_skills key). */
  enabled?: boolean;
  /** true = shipped with extension, cannot be deleted */
  builtIn?: boolean;
  /** Origin: 'user' | 'agent'. Optional for back-compat. */
  author?: SkillAuthor;
  /** ms timestamp of creation. */
  createdAt?: number;
  /** @deprecated since 2026-05-06 (issue #26). Back-compat only. */
  allowedTools?: string[] | null;
  /** @deprecated since 2026-05-06 (issue #26). Back-compat only. */
  firstRunConfirmedAt?: number;
}
