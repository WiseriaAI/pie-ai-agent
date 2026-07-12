import type { SkillSource } from "@/lib/skills/source";
import {
  requestListSkills, requestReadSkillFile, requestWriteSkill, requestDeleteSkill,
} from "./local-bridge";

/** 磁盘后端：全部经桥问 daemon（~/.pie/skills 为真源，扩展零缓存）。 */
export const daemonSkillSource: SkillSource = {
  mode: "disk",
  async list() {
    const { skills } = await requestListSkills();
    return skills.map((s) => ({
      id: s.name,
      // 展示名优先 frontmatter.name（中文名 skill 迁到 hash 目录时目录名不可读）
      name: s.displayName ?? s.name,
      description: s.description,
      builtIn: false,
      origin: "disk" as const,
      source: s.source ?? "pie", // 旧 daemon 无 source → 主根语义
      files: s.files,
      runnableScripts: s.runnableScripts,
    }));
  },
  async readFile(id, path) {
    try {
      return (await requestReadSkillFile({ name: id, path })).content;
    } catch {
      return null; // 缺文件/坏名 → null，与 IDB 后端语义一致
    }
  },
  async write(id, files) {
    await requestWriteSkill({ name: id, files });
  },
  async delete(id) {
    return (await requestDeleteSkill({ name: id })).deleted;
  },
};
