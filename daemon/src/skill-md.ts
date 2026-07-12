import { parse as parseYaml } from "yaml";
import type { SkillCaps } from "../../src/types/local-bridge";

export interface ParsedSkillMd {
  name: string;
  description: string;
  declaredCaps: SkillCaps;
  /** metadata.pie.network 里归一化不出合法域名、被安全丢弃的原始条目（作者信号用；
   *  空数组=全部合法）。安全语义不变：这些条目仍不进 declaredCaps.network，只是留个凭据
   *  让面板/日志/doctor 能告诉作者「你写错的域名被忽略了」。 */
  invalidNetwork: string[];
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** metadata.pie.network 归一化：整 URL / 带端口路径 → 裸域名（srt allowedDomains 语义）。
 *  解析不出合法域名形 → null（调用方丢弃——静默失效比放行错误值安全）。 */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split(/[/?#]/)[0]; // path / query / fragment
  s = s.replace(/^[^@]*@/, ""); // userinfo
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/\.+$/, ""); // trailing dots
  const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  return DOMAIN_RE.test(s) ? s : null;
}

/** strict YAML 解析失败时的宽松回退：只提零缩进的顶层 `name:`/`description:` 行。
 *  手写 SKILL.md 的 description 含「: 」（冒号+空格，中文语境极常见）会让 strict
 *  yaml 抛 Nested-mappings 错——不能因此让 skill 在 listSkills 里隐身（真机案例：
 *  2b 迁移包每次冷启动被重写且磁盘模式不可见）。回退拿不到 metadata.pie →
 *  declaredCaps 为空 → 默认沙箱（断网+写限）兜底，fail-safe 不降安全。 */
function lenientFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.+)$/.exec(line);
    if (kv && out[kv[1]] === undefined) out[kv[1]] = kv[2].trim();
  }
  return out;
}

export function parseSkillMd(md: string): ParsedSkillMd {
  const m = md.match(FENCE);
  if (!m) throw new Error("SKILL.md missing --- frontmatter --- fence");
  const [, yaml, body] = m;
  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(yaml) ?? {}) as Record<string, unknown>;
  } catch {
    fm = lenientFrontmatter(yaml);
  }

  const name = fm.name;
  const description = fm.description;
  if (typeof name !== "string" || !name) throw new Error("SKILL.md frontmatter missing required `name`");
  if (typeof description !== "string" || !description)
    throw new Error("SKILL.md frontmatter missing required `description`");

  const pie = ((fm.metadata as Record<string, unknown> | undefined)?.pie ?? {}) as Record<string, unknown>;
  // 单趟归一化：合法域名进 declaredCaps.network（安全语义不变），归一化不出的原始
  // 条目留进 invalidNetwork 供作者信号（面板 badge / daemon 日志 / pie doctor）。
  const network: string[] = [];
  const invalidNetwork: string[] = [];
  for (const raw of strArray(pie.network)) {
    const d = normalizeDomain(raw);
    if (d !== null) network.push(d);
    else invalidNetwork.push(raw);
  }
  return {
    name,
    description,
    declaredCaps: {
      network,
      write: strArray(pie.write),
    },
    invalidNetwork,
    body,
  };
}
