import type { SkillAuthor } from "./types";

/** SKILL.md frontmatter。scripts/hosts 在 SP-0+SP-1 仅解析、不消费(SP-2/SP-3 用)。 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: SkillAuthor;
  /** 可选、纯文档、不强制、不模板化。每项形如 "fields: 哪些字段要抽取"。 */
  inputs?: string[];
  capabilities?: {
    tools?: string[];
    scripts?: string[]; // SP-2 占位
    hosts?: string[];   // SP-3 占位
  };
}

/**
 * 一个 skill 包 = frontmatter + 虚拟文件树。
 * files 的 key 是相对路径(如 "SKILL.md"、"references/foo.md");
 * "SKILL.md" 必存,其 body(去掉 frontmatter)是 use_skill 返回的正文。
 */
export interface SkillPackage {
  id: string;
  frontmatter: SkillFrontmatter;
  files: Record<string, string>;
  builtIn: boolean;
  createdAt: number;
}
