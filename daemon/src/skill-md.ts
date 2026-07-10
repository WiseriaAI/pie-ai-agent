import { parse as parseYaml } from "yaml";
import type { SkillCaps } from "../../src/types/local-bridge";

export interface ParsedSkillMd {
  name: string;
  description: string;
  declaredCaps: SkillCaps;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export function parseSkillMd(md: string): ParsedSkillMd {
  const m = md.match(FENCE);
  if (!m) throw new Error("SKILL.md missing --- frontmatter --- fence");
  const [, yaml, body] = m;
  const fm = (parseYaml(yaml) ?? {}) as Record<string, unknown>;

  const name = fm.name;
  const description = fm.description;
  if (typeof name !== "string" || !name) throw new Error("SKILL.md frontmatter missing required `name`");
  if (typeof description !== "string" || !description)
    throw new Error("SKILL.md frontmatter missing required `description`");

  const pie = ((fm.metadata as Record<string, unknown> | undefined)?.pie ?? {}) as Record<string, unknown>;
  return {
    name,
    description,
    declaredCaps: { network: strArray(pie.network), write: strArray(pie.write) },
    body,
  };
}
