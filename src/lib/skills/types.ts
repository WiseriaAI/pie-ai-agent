export type SkillId = string;

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
}
