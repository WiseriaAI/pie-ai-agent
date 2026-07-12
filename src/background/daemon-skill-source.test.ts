import { describe, it, expect, vi, beforeEach } from "vitest";

// 桥四方法全 mock；daemonSkillSource 是纯映射层，不需要真桥。
const requestListSkills = vi.fn();
const requestReadSkillFile = vi.fn();
const requestWriteSkill = vi.fn();
const requestDeleteSkill = vi.fn();

vi.mock("./local-bridge", () => ({
  requestListSkills: (...args: unknown[]) => requestListSkills(...args),
  requestReadSkillFile: (...args: unknown[]) => requestReadSkillFile(...args),
  requestWriteSkill: (...args: unknown[]) => requestWriteSkill(...args),
  requestDeleteSkill: (...args: unknown[]) => requestDeleteSkill(...args),
}));

import { daemonSkillSource } from "./daemon-skill-source";

beforeEach(() => {
  requestListSkills.mockReset();
  requestReadSkillFile.mockReset();
  requestWriteSkill.mockReset();
  requestDeleteSkill.mockReset();
});

describe("daemonSkillSource", () => {
  it("mode 是 disk", () => {
    expect(daemonSkillSource.mode).toBe("disk");
  });

  it("list() 把 daemon SkillSummary 精确映射成 SkillEntry（id=name、origin=disk、builtIn=false、files/runnableScripts 透传）", async () => {
    requestListSkills.mockResolvedValue({
      skills: [
        {
          name: "web-fetch",
          description: "fetch a url",
          runnableScripts: ["fetch.ts"],
          declaredCaps: { network: ["example.com"], write: [] },
          files: ["SKILL.md", "scripts/fetch.ts"],
        },
      ],
    });

    const entries = await daemonSkillSource.list();

    expect(entries).toEqual([
      {
        id: "web-fetch",
        name: "web-fetch",
        description: "fetch a url",
        builtIn: false,
        origin: "disk",
        source: "pie", // 旧 daemon 无 source → 主根语义
        files: ["SKILL.md", "scripts/fetch.ts"],
        runnableScripts: ["fetch.ts"],
      },
    ]);
  });

  it("list() displayName 存在时作展示名（id 仍是目录名）——中文名 skill 迁到 hash 目录场景", async () => {
    requestListSkills.mockResolvedValue({
      skills: [
        {
          name: "skill-ab12cd34",
          displayName: "纯中文技能名",
          description: "d",
          runnableScripts: [],
          declaredCaps: { network: [], write: [] },
          files: ["SKILL.md"],
        },
      ],
    });

    const [entry] = await daemonSkillSource.list();

    expect(entry.id).toBe("skill-ab12cd34"); // 调用身份 = 目录名
    expect(entry.name).toBe("纯中文技能名"); // 展示名 = frontmatter.name
  });

  it("list() 空数组时返回空数组", async () => {
    requestListSkills.mockResolvedValue({ skills: [] });
    expect(await daemonSkillSource.list()).toEqual([]);
  });

  it("readFile 成功时返回 daemon 的 content，且参数原样转发", async () => {
    requestReadSkillFile.mockResolvedValue({ content: "hello world" });

    const content = await daemonSkillSource.readFile("web-fetch", "SKILL.md");

    expect(content).toBe("hello world");
    expect(requestReadSkillFile).toHaveBeenCalledWith({ name: "web-fetch", path: "SKILL.md" });
  });

  it("readFile 时桥抛错 → 返回 null（与 IDB 后端语义一致）", async () => {
    requestReadSkillFile.mockRejectedValue(new Error("not_found"));

    const content = await daemonSkillSource.readFile("web-fetch", "nope.md");

    expect(content).toBeNull();
  });

  it("write 把 {name, files} 转发给 requestWriteSkill", async () => {
    requestWriteSkill.mockResolvedValue({ dir: "/tmp/web-fetch" });
    const files = [{ path: "SKILL.md", content: "body" }];

    await daemonSkillSource.write("web-fetch", files);

    expect(requestWriteSkill).toHaveBeenCalledWith({ name: "web-fetch", files });
  });

  it("delete 返回 requestDeleteSkill 结果里的 .deleted", async () => {
    requestDeleteSkill.mockResolvedValue({ deleted: true });
    expect(await daemonSkillSource.delete("web-fetch")).toBe(true);
    expect(requestDeleteSkill).toHaveBeenCalledWith({ name: "web-fetch" });

    requestDeleteSkill.mockResolvedValue({ deleted: false });
    expect(await daemonSkillSource.delete("web-fetch")).toBe(false);
  });
});
