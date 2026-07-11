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
const maybeInitLocalBridge = vi.fn();

vi.mock("./local-bridge", () => ({
  bridgeHasSkillFs: () => hasSkillFs,
  bridgeSettled: () => settledPromise,
  requestListSkills: (...args: unknown[]) => requestListSkills(...args),
  requestWriteSkill: (...args: unknown[]) => requestWriteSkill(...args),
  maybeInitLocalBridge: (...args: unknown[]) => maybeInitLocalBridge(...args),
}));

// Partial mock of skill-store: everything is the real implementation (backed
// by fake-indexeddb via src/test/setup.ts) except listPackages, which is
// wrapped in a spy so test (g) can force a rejection without disturbing the
// real CRUD the other tests rely on for fixture setup/teardown.
vi.mock("@/lib/skills/skill-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skills/skill-store")>();
  return { ...actual, listPackages: vi.fn(actual.listPackages) };
});

// Partial mock of storage: setSkillEnabled spy-wraps the real impl so test
// (重要2) can force a single rejection while every other call (including the
// tests' own marker seeding) still hits the real IDB-backed store.
vi.mock("@/lib/skills/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skills/storage")>();
  return { ...actual, setSkillEnabled: vi.fn(actual.setSkillEnabled) };
});

import { listPackages, putPackage, deletePackage } from "@/lib/skills/skill-store";
import { getEnabledSkillIds, setSkillEnabled } from "@/lib/skills/storage";
import { _resetForTests } from "@/lib/idb/db";
import { migrateIdbSkillsToDisk, initBridgeAndMigrate } from "./skill-migration";

const mockedListPackages = vi.mocked(listPackages);
const mockedSetSkillEnabled = vi.mocked(setSkillEnabled);

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
  maybeInitLocalBridge.mockReset();
  maybeInitLocalBridge.mockResolvedValue(undefined);
  // mockClear（非 mockReset）：保留 vi.fn(actual.setSkillEnabled) 烘进去的真实现，
  // 只清调用计数；(重要2) 的 mockRejectedValueOnce 是一次性的，测试内即耗尽。
  mockedSetSkillEnabled.mockClear();
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

  it("(e) 空 slug（纯非 ASCII 名字）→ 确定性 hash 目录名迁移（skill-<hex8>），二跑幂等", async () => {
    // 中文名是常态，不能静默不迁移；hash(名字) 派生目录名保证同名恒同 slug →
    // existing 检查照常幂等（随机名会每轮迁一份新的，被明确否掉）。
    await putPackage(makePkg("skill_user_1", "纯中文技能名"));

    const result = await migrateIdbSkillsToDisk();

    expect(result.migrated).toHaveLength(1);
    const slug = result.migrated[0];
    expect(slug).toMatch(/^skill-[0-9a-f]{8}$/);
    expect(result.skipped).toEqual([]);
    expect(requestWriteSkill).toHaveBeenCalledTimes(1);
    expect(requestWriteSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: slug }),
    );

    // 二跑：磁盘上已有该 slug → skip（幂等成立的前提 = slug 确定性）
    requestListSkills.mockResolvedValue({ skills: [daemonEntry(slug)] });
    requestWriteSkill.mockClear();
    const second = await migrateIdbSkillsToDisk();
    expect(second.migrated).toEqual([]);
    expect(second.skipped).toEqual([slug]);
    expect(requestWriteSkill).not.toHaveBeenCalled();
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

  it("(重要1a) crash 恢复：已在盘 skip 分支也继承显式关 marker（slug 无任何 marker 时）", async () => {
    // 场景：上一轮写完盘但没来得及写 marker 就挂了 → 这一轮走 skip 分支自愈补写。
    await putPackage(makePkg("skill_user_1", "Disabled Skill"));
    await setSkillEnabled("skill_user_1", false);
    requestListSkills.mockResolvedValue({ skills: [daemonEntry("disabled-skill")] });

    const result = await migrateIdbSkillsToDisk();

    expect(result.skipped).toEqual(["disabled-skill"]);
    expect(result.migrated).toEqual([]);
    const markers = await getEnabledSkillIds();
    expect(markers).toContain("!disabled-skill");
  });

  it("(重要1b) 不覆盖用户磁盘侧选择：slug 已有 plain marker → skip 分支不写 !slug", async () => {
    await putPackage(makePkg("skill_user_1", "Disabled Skill"));
    await setSkillEnabled("skill_user_1", false);
    await setSkillEnabled("disabled-skill", true); // 用户在磁盘模式下显式开过
    requestListSkills.mockResolvedValue({ skills: [daemonEntry("disabled-skill")] });

    await migrateIdbSkillsToDisk();

    const markers = await getEnabledSkillIds();
    expect(markers).toContain("disabled-skill");
    expect(markers).not.toContain("!disabled-skill");
    // 迁移过程零 marker 写入：仅有的 2 次调用是本测试自己的 seeding。
    expect(mockedSetSkillEnabled).toHaveBeenCalledTimes(2);
  });

  it("(M-T10a) slug 撞名：本轮刚迁的 slug 不被撞名包的 skip 自愈禁用", async () => {
    // A "Foo Bar"（无 marker，默认开）先迁成 "foo-bar"；B "Foo  Bar!"（显式关）
    // kebab 撞出同一 slug 走 skip 分支——B 的自愈继承不得把刚迁好的 A 关掉。
    await putPackage(makePkg("skill_user_1", "Foo Bar"));
    await putPackage(makePkg("skill_user_2", "Foo  Bar!"));
    await setSkillEnabled("skill_user_2", false);

    const result = await migrateIdbSkillsToDisk();

    expect(result.migrated).toEqual(["foo-bar"]);
    expect(result.skipped).toEqual(["foo-bar"]);
    expect(mockedSetSkillEnabled).not.toHaveBeenCalledWith("foo-bar", false);
    const markers = await getEnabledSkillIds();
    expect(markers).not.toContain("!foo-bar");
  });

  it("(重要2) marker 写失败 → slug 只在 migrated（不入 skipped）+ warn", async () => {
    await putPackage(makePkg("skill_user_1", "Disabled Skill"));
    await setSkillEnabled("skill_user_1", false); // 真 seeding
    mockedSetSkillEnabled.mockRejectedValueOnce(new Error("marker write failed"));

    const result = await migrateIdbSkillsToDisk();

    expect(result.migrated).toEqual(["disabled-skill"]);
    expect(result.skipped).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("initBridgeAndMigrate", () => {
  it("(严重) 顺序契约：等 maybeInitLocalBridge 完成才迁移（并行发射会确定性空转）", async () => {
    // 复现原缺陷形态：init 挂在跨进程 IPC（这里用受控 deferred 模拟）期间，
    // skill_fs 能力还不可见。若实现并行发射（void init; migrate()），migrate
    // 会在 hasSkillFs=false 时早退——resolveInit 之后 requestListSkills 也
    // 永远不会被调，最终断言失败。
    await putPackage(makePkg("skill_user_1", "My Skill"));
    hasSkillFs = false;
    let resolveInit!: () => void;
    maybeInitLocalBridge.mockImplementation(
      () => new Promise<void>((r) => { resolveInit = r; }),
    );

    const pending = initBridgeAndMigrate();

    // init 未落定：迁移不得已经开跑（排干几轮微任务给错误实现暴露机会）。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(requestListSkills).not.toHaveBeenCalled();

    hasSkillFs = true; // 模拟 init 完成把能力翻亮
    resolveInit();
    await pending;

    expect(requestListSkills).toHaveBeenCalled();
  });
});
