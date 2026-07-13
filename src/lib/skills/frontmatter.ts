import type { SkillFrontmatter } from "./package-types";

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * 极简 YAML 子集解析：够 frontmatter 用，不引第三方 YAML 库（避免给 SW 增包）。
 * 支持：`key: value`、`key:` 后跟 `  - item` 列表、`[a, b]` 内联数组。
 * 不支持多层嵌套/锚点等完整 YAML。
 * 限制：key 仅匹配 `[\w]+`，不支持带连字符的 key（如 `some-key`）。
 *
 * 老 idb 包可能仍带 `capabilities:` 嵌套块（该字段已删，见 issue #303）——不再特判：
 * 嵌套子键退化成顶层散键、其列表项按普通列表头处理，均无害地落进 root 后被忽略；
 * 必填的 name / description / body 不受影响（有测试钉住）。
 */
export function parseSkillMarkdown(md: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const m = md.match(FENCE);
  if (!m) throw new Error("SKILL.md missing --- frontmatter --- fence");
  const [, yaml, body] = m;

  const root: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let listKey: string | null = null;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    if (listItem && listKey) {
      ((root[listKey] as string[]) ??= []).push(listItem[1].trim());
      continue;
    }
    const kv = raw.match(/^(\s*)([\w]+):\s*(.*)$/);
    if (!kv) continue;
    const [, , key, valRaw] = kv;
    const val = valRaw.trim();

    if (val === "") {
      // 列表头(inputs:) 或空的嵌套对象头(老 capabilities:) —— 后者退化成空列表，无害。
      root[key] = [];
      listKey = key;
    } else {
      root[key] = parseScalar(val);
      listKey = null;
    }
  }

  const name = root.name;
  const description = root.description;
  if (typeof name !== "string" || !name)
    throw new Error("SKILL.md frontmatter missing required `name`");
  if (typeof description !== "string" || !description)
    throw new Error("SKILL.md frontmatter missing required `description`");

  return {
    frontmatter: {
      name,
      description,
      version: root.version as string | undefined,
      author: root.author as SkillFrontmatter["author"],
      inputs: root.inputs as string[] | undefined,
    },
    body,
  };
}

function parseScalar(v: string): unknown {
  const arr = v.match(/^\[(.*)\]$/);
  if (arr) {
    return arr[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return v;
}
