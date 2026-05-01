// Slash-command resolution for Chat input. Phase 2.6 follow-up.
//
// User types `/<key>` (or `/<key> <args>`) where <key> is either a skill id
// or a slugified skill name. If a match is found, the chat input is
// rewritten to a clear instruction the LLM can act on; otherwise the raw
// text is passed through (so `/something_unrelated` becomes plain text).
//
// Backward compatible: the legacy `/skill <key> [args]` form still works
// — it routes through the same resolver after stripping the `/skill`
// prefix.

import type { SkillDefinition } from "./types";

/**
 * Normalize a string for slash-key comparison.
 *   - lowercase
 *   - whitespace and underscore collapse to single hyphen
 *   - punctuation stripped (except hyphen and CJK chars)
 *   - leading/trailing hyphens trimmed
 *
 * Examples:
 *   "Extract Structured Data" → "extract-structured-data"
 *   "提取表格"               → "提取表格"     (CJK kept)
 *   "skill_agent_uuid"        → "skill-agent-uuid"
 */
export function normalizeSkillSlashKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    // Keep word chars, hyphen, and CJK Unified Ideographs (U+4E00–U+9FFF)
    .replace(/[^\w一-鿿-]/g, "")
    .replace(/^-+|-+$/g, "");
}

/**
 * Look up a skill by slash key. Tries id first (exact match), then
 * normalized name match. Returns null when no match. When multiple skills
 * normalize to the same key, prefers user > agent > built-in (so a user's
 * deliberate naming wins over a built-in coincidence).
 */
export function findSkillBySlashKey(
  skills: SkillDefinition[],
  key: string,
): SkillDefinition | null {
  // 1. exact id match (covers programmatic Run-button case where prefill
  // is already the literal id)
  const byId = skills.find((s) => s.id === key);
  if (byId) return byId;

  // 2. normalized name match
  const nKey = normalizeSkillSlashKey(key);
  if (!nKey) return null;
  const matches = skills.filter((s) => normalizeSkillSlashKey(s.name) === nKey);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // 3. tie-break: user-authored > agent-authored > built-in
  const rank = (s: SkillDefinition): number =>
    s.builtIn ? 2 : s.author === "agent" ? 1 : 0;
  return [...matches].sort((a, b) => rank(a) - rank(b))[0];
}

export interface SlashCommandMatch {
  skill: SkillDefinition;
  /** Whatever the user typed after the skill key, untouched. May be empty. */
  rest: string;
}

/**
 * Parse and resolve a chat input as a slash command.
 *
 *   "/extract-tables"           → match if a skill normalizes to that key
 *   "/extract-tables col1,col2" → match with rest="col1,col2"
 *   "/skill skill_xyz extra"    → legacy form, equivalent to "/skill_xyz extra"
 *   "hello"                     → null (not a slash command)
 *   "/unknown"                  → null (no match → caller passes raw text)
 */
export function resolveSlashCommand(
  text: string,
  skills: SkillDefinition[],
): SlashCommandMatch | null {
  // Legacy /skill <key> [rest] — strip prefix, fall through.
  const legacy = text.match(/^\/skill\s+(\S+)(?:\s+([\s\S]*))?$/);
  if (legacy) {
    const skill = findSkillBySlashKey(skills, legacy[1]);
    if (!skill) return null;
    return { skill, rest: (legacy[2] ?? "").trim() };
  }

  // New shorthand /<key> [rest]
  const shorthand = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!shorthand) return null;
  const key = shorthand[1];
  const rest = (shorthand[2] ?? "").trim();
  const skill = findSkillBySlashKey(skills, key);
  if (!skill) return null;
  return { skill, rest };
}

/**
 * Render the LLM-facing instruction for a resolved slash command. The
 * resulting string replaces the user's raw input in the chat history sent
 * to the LLM (so the model sees a clear directive, not a slash form it
 * may misinterpret).
 */
export function expandSlashCommand(match: SlashCommandMatch): string {
  const base = `Run the "${match.skill.name}" skill (id: ${match.skill.id}).`;
  return match.rest
    ? `${base} Additional input from the user: ${match.rest}`
    : base;
}
