import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SkillPackage } from "@/lib/skills/package-types";

// Bridge surface — fully controllable per test (idiom borrowed from
// skill-source.test.ts's "module-level-mutable-vars-before-SUT-import" pattern:
// vi.mock factories close over `let` bindings reassigned in beforeEach, and the
// SUT import happens after the vi.mock call so it always resolves to the mock).
let hasSkillFs = true;
let settledPromise: Promise<void> = Promise.resolve();
const requestListSkills = vi.fn();
const requestWriteSkill = vi.fn();

vi.mock("./local-bridge", () => ({
  bridgeHasSkillFs: () => hasSkillFs,
  bridgeSettled: () => settledPromise,
  requestListSkills: (...args: unknown[]) => requestListSkills(...args),
  requestWriteSkill: (...args: unknown[]) => requestWriteSkill(...args),
}));

// Partial mock of skill-store: everything is the real implementation (backed
// by fake-indexeddb via src/test/setup.ts) except listPackages, which is
// wrapped in a spy so test (g) can force a rejection without disturbing the
// real CRUD the other tests rely on for fixture setup/teardown.
vi.mock("@/lib/skills/skill-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skills/skill-store")>();
  return { ...actual, listPackages: vi.fn(actual.listPackages) };
});

import { listPackages, putPackage, deletePackage } from "@/lib/skills/skill-store";
import { getEnabledSkillIds, setSkillEnabled } from "@/lib/skills/storage";
import { _resetForTests } from "@/lib/idb/db";
import { migrateIdbSkillsToDisk } from "./skill-migration";

const mockedListPackages = vi.mocked(listPackages);

function makePkg(id: string, name: string, files?: Record<string, string>): SkillPackage {
  return {
    id,
    frontmatter: { name, description: `${name} 描述` },
    files: files ?? { "SKILL.md": `---\nname: ${name}\n---\nBody` },
    builtIn: false,
    createdAt: Date.now(),
  };
}

const daemonEntry = (name: string) => ({
  name,
  description: "",
  runnableScripts: [],
  declaredCaps: { network: [], write: [] },
  files: [] as string[],
});

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  hasSkillFs = true;
  settledPromise = Promise.resolve();
  requestListSkills.mockReset();
  requestListSkills.mockResolvedValue({ skills: [] });
  requestWriteSkill.mockReset();
  requestWriteSkill.mockResolvedValue({ dir: "/tmp/whatever" });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  // enabled_skills marker 存 "pie" config store，须每测重置，否则跨测试串味。
  await _resetForTests();
  for (const p of await listPackages()) await deletePackage(p.id);
  // mockClear 放在清理循环之后：循环本身也调用 listPackages，若先 clear 会把
  // 这次清理调用计入正文断言，污染 "not.toHaveBeenCalled()" 这类计数断言。
  mockedListPackages.mockClear();
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("migrateIdbSkillsToDisk", () => {
  it("(a) bridgeHasSkillFs()=false → 立即返回空结果，零 daemon 调用", async () => {
    hasSkillFs = false;
    await putPackage(makePkg("skill_user_1", "My Skill"));

    const result = await migrateIdbSkillsToDisk();

    expect(result).toEqual({ migrated: [], skipped: [] });
    expect(mockedListPackages).not.toHaveBeenCalled();
    expect(requestListSkills).not.toHaveBeenCalled();
    expect(requestWriteSkill).not.toHaveBeenCalled();
  });

  it("(rule 2) IDB 无用户 skill → 不调 requestListSkills，直接返回空结果", async () => {
    const result = await migrateIdbSkillsToDisk();

    expect(result).toEqual({ migrated: [], skipped: [] });
    expect(requestListSkills).not.toHaveBeenCalled();
  });

  it("(b) 正常迁移：files 铺开为 {path,content}[]，name 走 slug 化", async () => {
    await putPackage(
      makePkg("skill_user_1", "My Cool Skill", {
        "SKILL.md": "---\nname: My Cool Skill\n---\nBody",
        "references/foo.md": "foo content",
      }),
    );

    const result = await migrateIdbSkillsToDisk();

    expect(result.migrated).toEqual(["my-cool-skill"]);
    expect(result.skipped).toEqual([]);
    expect(requestWriteSkill).toHaveBeenCalledWith({
      name: "my-cool-skill",
      files: [
        { path: "SKILL.md", content: "---\nname: My Cool Skill\n---\nBody" },
        { path: "references/foo.md", content: "foo content" },
      ],
    });
  });

  it("(c1) 同名已在盘 → skipped，requestWriteSkill 不为它调用", async () => {
    requestListSkills.mockResolvedValue({ skills: [daemonEntry("my-cool-skill")] });
    await putPackage(makePkg("skill_user_1", "My Cool Skill"));

    const result = await migrateIdbSkillsToDisk();

    expect(result.skipped).toEqual(["my-cool-skill"]);
    expect(result.migrated).toEqual([]);
    expect(requestWriteSkill).not.toHaveBeenCalled();
  });

  it("(c2) 幂等：迁移后磁盘已反映该 skill，再跑一次 migrated 为空", async () => {
    await putPackage(makePkg("skill_user_1", "My Cool Skill"));

    const first = await migrateIdbSkillsToDisk();
    expect(first.migrated).toEqual(["my-cool-skill"]);

    // 模拟 daemon 侧真实状态：现在磁盘上已经有这个 skill 了。
    requestListSkills.mockResolvedValue({ skills: [daemonEntry("my-cool-skill")] });
    requestWriteSkill.mockClear();

    const second = await migrateIdbSkillsToDisk();

    expect(second.migrated).toEqual([]);
    expect(requestWriteSkill).not.toHaveBeenCalled();
  });

  it("(d) 显式关 marker 继承到 slug；未标记 pkg 不写 marker", async () => {
    await putPackage(makePkg("skill_user_1", "Disabled Skill"));
    await putPackage(makePkg("skill_user_2", "Enabled Skill"));
    await setSkillEnabled("skill_user_1", false);

    await migrateIdbSkillsToDisk();

    const markers = await getEnabledSkillIds();
    expect(markers).toContain("!disabled-skill");
    expect(markers).not.toContain("!enabled-skill");
    expect(markers).not.toContain("enabled-skill");
  });

  it("(e) 空 slug（纯非 ASCII 名字）→ skipped + console.warn，不写盘", async () => {
    await putPackage(makePkg("skill_user_1", "纯中文技能名"));

    const result = await migrateIdbSkillsToDisk();

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual(["纯中文技能名"]);
    expect(requestWriteSkill).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("(f) 一个 pkg 的 requestWriteSkill 拒绝 → 落 skipped，其余仍正常迁移", async () => {
    await putPackage(makePkg("skill_user_1", "Good Skill"));
    await putPackage(makePkg("skill_user_2", "Bad Skill"));
    requestWriteSkill.mockImplementation(async (p: unknown) => {
      const { name } = p as { name: string };
      if (name === "bad-skill") throw new Error("disk write failed");
      return { dir: "/tmp/x" };
    });

    const result = await migrateIdbSkillsToDisk();

    expect(result.migrated).toEqual(["good-skill"]);
    expect(result.skipped).toEqual(["bad-skill"]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("(g) listPackages 本身抛错 → 整体不抛，返回部分/空结果 + warn", async () => {
    mockedListPackages.mockRejectedValueOnce(new Error("idb exploded"));

    const result = await migrateIdbSkillsToDisk();

    expect(result).toEqual({ migrated: [], skipped: [] });
    expect(warnSpy).toHaveBeenCalled();
  });
});
