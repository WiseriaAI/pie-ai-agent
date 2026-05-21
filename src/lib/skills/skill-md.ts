/**
 * Shared SKILL.md building helpers — single source of truth for both the
 * agent-facing skill-meta tools and the SkillsList UI component.
 *
 * Extracted during Task 13 cleanup (SP-1) to eliminate the previously
 * duplicated copies in skill-meta.ts and SkillsList.tsx.
 */

/**
 * Frontmatter-injection guard. `name` / `description` are interpolated raw
 * into the YAML frontmatter of SKILL.md. A value containing a newline could
 * inject arbitrary frontmatter keys, and an embedded `---` fence could close
 * the frontmatter early (dropping `author: agent` and bypassing P0-C).
 * Legitimate names/descriptions are single-line, so reject newlines and the
 * literal `---` fence.
 */
export function isSingleLineSafe(v: string): boolean {
  return !/[\r\n]/.test(v) && !v.includes("---");
}

/**
 * Build a SKILL.md string with YAML frontmatter from the given fields and
 * body (instructions). The shape produced here is what `parseSkillMarkdown`
 * in frontmatter.ts expects.
 */
export function buildSkillMd(
  name: string,
  description: string,
  version: string,
  author: string,
  instructions: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\nauthor: ${author}\n---\n${instructions}`;
}
