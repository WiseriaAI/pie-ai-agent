import type { SkillFrontmatter } from "./package-types";

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * 极简 YAML 子集解析：够 frontmatter 用，不引第三方 YAML 库（避免给 SW 增包）。
 * 支持：`key: value`、`key:` 后跟 `  - item` 列表、`[a, b]` 内联数组、
 * `capabilities:` 一层嵌套。不支持多层嵌套/锚点等完整 YAML。
 * 限制：key 仅匹配 `[\w]+`，不支持带连字符的 key（如 `some-key`）。
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
  let listTarget: Record<string, unknown> = root;
  let nestKey: string | null = null;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    if (listItem && listKey) {
      ((listTarget[listKey] as string[]) ??= []).push(listItem[1].trim());
      continue;
    }
    const kv = raw.match(/^(\s*)([\w]+):\s*(.*)$/);
    if (!kv) continue;
    const [, indent, key, valRaw] = kv;
    const val = valRaw.trim();

    if (indent && nestKey) {
      const nest = (root[nestKey] as Record<string, unknown>) ?? {};
      // 空值可能是块状列表头(`tools:` 后跟 `- item`)——初始化成数组，
      // 否则下面的 list-push `??=` 不会替换 "" 字符串，.push 会抛错。
      nest[key] = val === "" ? [] : parseScalar(val);
      root[nestKey] = nest;
      listKey = val === "" ? key : null;
      listTarget = nest;
      continue;
    }
    if (val === "") {
      // 可能是列表头(inputs:)或嵌套对象头(capabilities:)
      root[key] = key === "capabilities" ? {} : [];
      listKey = key === "capabilities" ? null : key;
      nestKey = key === "capabilities" ? key : null;
      listTarget = root;
    } else {
      root[key] = parseScalar(val);
      listKey = null;
      nestKey = null;
      listTarget = root;
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
      capabilities: root.capabilities as SkillFrontmatter["capabilities"],
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
