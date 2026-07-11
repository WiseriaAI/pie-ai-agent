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

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Frontmatter 保真更新：只行级替换零缩进的顶层 `name:`/`description:`/`author:`
 * 三个键（缺失则追加），其余 frontmatter（`metadata.pie` 能力声明 / `license` /
 * `allowed-tools` / `version` / 任何手写键）逐字保留，正文整体替换。
 *
 * 为什么不用 buildSkillMd 整体重建：磁盘 skill（对齐 Agent Skills 标准）可以
 * 手写任意 frontmatter——重建会把 `metadata.pie.network/write` 这类能力声明
 * 静默剥掉（Slice 2 终审 Important#1）；IDB 老包的 `capabilities.scripts`
 * 同理。调用方仍须先过 isSingleLineSafe 守卫（值是原样内插进 YAML 行的）。
 *
 * 无 fence 的输入（不该出现，但读失败后的空串会走到这）退回全新构建。
 */
export function patchSkillMd(
  originalMd: string,
  patch: { name: string; description: string; author: string },
  instructions: string,
): string {
  const m = originalMd.match(FENCE);
  if (!m) return buildSkillMd(patch.name, patch.description, "1.0.0", patch.author, instructions);

  const lines = m[1].split(/\r?\n/);
  const seen = new Set<string>();
  const patched = lines.map((line) => {
    const key = /^(name|description|author):/.exec(line)?.[1] as
      | keyof typeof patch
      | undefined;
    if (!key) return line; // 缩进行（嵌套键）与其他顶层键原样保留
    seen.add(key);
    return `${key}: ${patch[key]}`;
  });
  for (const key of ["name", "description", "author"] as const) {
    if (!seen.has(key)) patched.push(`${key}: ${patch[key]}`);
  }
  return `---\n${patched.join("\n")}\n---\n${instructions}`;
}
