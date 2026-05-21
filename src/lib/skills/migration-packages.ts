// One-shot, idempotent migration of legacy `skill_*` chrome.storage.local
// records (old SkillDefinition with `promptTemplate`) into IndexedDB
// SkillPackages. After a successful putPackage for each, the legacy keys are
// removed so the migration is a no-op on subsequent runs.
//
// Wired fire-and-forget into the SW startup sequence (src/background/index.ts),
// alongside migrateV1toV2 / cleanupThinShellSkills.
//
// Defensive: only keys that (a) start with `skill_`, (b) hold an object value,
// and (c) carry a string `id` are treated as legacy skill records. The
// `enabled_skills` key (a string[] whitelist/blacklist) is never touched.

import type { SkillPackage } from "./package-types";
import { putPackage } from "./skill-store";

/** Legacy SkillDefinition shape we read from chrome.storage.local. */
interface LegacySkill {
  id: string;
  name?: unknown;
  description?: unknown;
  promptTemplate?: unknown;
  author?: unknown;
  createdAt?: unknown;
  builtIn?: unknown;
}

function isLegacySkill(value: unknown): value is LegacySkill {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/**
 * Sanitize a single-line frontmatter scalar (name / description). Legacy data
 * is trusted-ish, but a stray newline or `---` fence would corrupt the YAML
 * frontmatter, so collapse those defensively rather than fail the whole record.
 */
function sanitizeScalar(v: unknown, fallback: string): string {
  const s = typeof v === "string" && v.trim() ? v : fallback;
  return s.replace(/[\r\n]+/g, " ").replace(/---/g, "—").trim();
}

export async function migrateSkillsToPackages(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const legacyKeys: string[] = [];

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("skill_")) continue;
    if (!isLegacySkill(value)) continue;

    const name = sanitizeScalar(value.name, value.id);
    const description = sanitizeScalar(value.description, "");
    const author =
      value.author === "agent" ? "agent" : ("user" as const);
    const createdAt =
      typeof value.createdAt === "number" ? value.createdAt : Date.now();
    const body =
      typeof value.promptTemplate === "string" ? value.promptTemplate : "";

    const md = `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\nauthor: ${author}\n---\n${body}`;

    const pkg: SkillPackage = {
      id: value.id,
      frontmatter: { name, description, version: "1.0.0", author },
      files: { "SKILL.md": md },
      builtIn: false,
      createdAt,
    };

    await putPackage(pkg);
    legacyKeys.push(key);
  }

  if (legacyKeys.length > 0) {
    await chrome.storage.local.remove(legacyKeys);
  }
}
