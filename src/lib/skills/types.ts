export type SkillId = string;

export type SkillAuthor = "user" | "agent";

export interface SkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters object */
  toolSchema: {
    parameters: Record<string, unknown>;
  };
  /**
   * Handlebars-style template: {{key}} is replaced with JSON.stringify(args[key]).
   * The rendered result is wrapped in <untrusted_skill_params> before being
   * returned as an observation, so the LLM sees it as untrusted injected context.
   */
  promptTemplate: string;
  /** Whether this skill is currently enabled. For built-in skills this is the
   *  default; user choice stored in enabled_skills array overrides. */
  enabled: boolean;
  /** true = shipped with extension, cannot be deleted */
  builtIn: boolean;
  /** Origin of this skill. 'user' = manually created via SkillsList;
   *  'agent' = created or last-modified via meta tools (taint propagation, P0-C).
   *  Optional for back-compat with pre-Phase-2.6 storage; defaults to 'user'
   *  when missing. */
  author?: SkillAuthor;
  /** ms timestamp of creation. Used for SkillsList sort.
   *  Built-in skills use 0 (sorts to bottom). Optional for back-compat. */
  createdAt?: number;
  /**
   * @deprecated since 2026-05-06 (issue #26). Field kept for back-compat
   * deserialization of pre-#26 storage data; new code paths neither read
   * nor write it. R2 enforcement was removed alongside the field.
   */
  allowedTools?: string[] | null;
  /**
   * @deprecated since 2026-05-06 (issue #26). R10 first-run-confirm was
   * removed; field kept for back-compat deserialization only.
   */
  firstRunConfirmedAt?: number;
}
