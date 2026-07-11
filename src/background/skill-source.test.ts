import { describe, it, expect, vi, beforeEach } from "vitest";
import { listPackages, deletePackage } from "@/lib/skills/skill-store";
import { setSkillEnabled } from "@/lib/skills/storage";
import { BUILT_IN_SKILL_PACKAGES } from "@/lib/skills/builtin";
import { _resetForTests } from "@/lib/idb/db";

// bridgeHasSkillFs 可控（模式判定的开关）；bridgeSettled 默认已落定，
// 个别测试把 settledPromise 换成待决 promise 来断言"list() 等它落定才跑"；
// requestListSkills 是唯一被 daemon 后端调用的桥方法。
let hasSkillFs = false;
let settledPromise: Promise<void> = Promise.resolve();
const requestListSkills = vi.fn();

vi.mock("./local-bridge", () => ({
  bridgeHasSkillFs: () => hasSkillFs,
  bridgeSettled: () => settledPromise,
  requestListSkills: (...args: unknown[]) => requestListSkills(...args),
  requestReadSkillFile: vi.fn(),
  requestWriteSkill: vi.fn(),
  requestDeleteSkill: vi.fn(),
}));

import { getActiveSkillSource, getEnabledSkillEntries } from "./skill-source";

const DAEMON_ENTRY_NAME = "custom-daemon-skill";

beforeEach(async () => {
  hasSkillFs = false;
  settledPromise = Promise.resolve();
  requestListSkills.mockReset();
  requestListSkills.mockResolvedValue({
    skills: [
      {
        name: DAEMON_ENTRY_NAME,
        description: "daemon 提供的 skill",
        runnableScripts: [],
        declaredCaps: { network: [], write: [] },
        files: ["SKILL.md"],
      },
    ],
  });
  // enabled_skills marker 存 IDB config store；须每测重置，否则跨测试串味。
  await _resetForTests();
  for (const p of await listPackages()) await deletePackage(p.id);
});

describe("getActiveSkillSource", () => {
  it("bridgeHasSkillFs()=false → mode idb，list 含 builtin 条目，不问 daemon", async () => {
    hasSkillFs = false;

    const source = getActiveSkillSource();
    expect(source.mode).toBe("idb");

    const entries = await source.list();
    expect(entries.some((e) => e.id === BUILT_IN_SKILL_PACKAGES[0].id)).toBe(true);
    expect(entries.some((e) => e.id === DAEMON_ENTRY_NAME)).toBe(false);
    expect(requestListSkills).not.toHaveBeenCalled();
  });

  it("bridgeHasSkillFs()=true → mode disk，list = builtin + mocked daemon 条目", async () => {
    hasSkillFs = true;

    const source = getActiveSkillSource();
    expect(source.mode).toBe("disk");

    const entries = await source.list();
    expect(entries.some((e) => e.id === BUILT_IN_SKILL_PACKAGES[0].id)).toBe(true);
    const daemon = entries.find((e) => e.id === DAEMON_ENTRY_NAME);
    expect(daemon).toBeDefined();
    expect(daemon?.origin).toBe("disk");
    expect(daemon?.builtIn).toBe(false);
  });
});

describe("getEnabledSkillEntries", () => {
  it("mocked daemon 条目默认在（disk 默认开）", async () => {
    hasSkillFs = true;

    const enabled = await getEnabledSkillEntries();

    expect(enabled.some((e) => e.id === DAEMON_ENTRY_NAME)).toBe(true);
  });

  it("!-marker（setSkillEnabled(name, false)）能关掉 daemon 条目", async () => {
    hasSkillFs = true;
    await setSkillEnabled(DAEMON_ENTRY_NAME, false);

    const enabled = await getEnabledSkillEntries();

    expect(enabled.some((e) => e.id === DAEMON_ENTRY_NAME)).toBe(false);
  });

  it("先等 bridgeSettled 落定再取 list（不提前用陈旧模式判定跑 list）", async () => {
    hasSkillFs = true;
    let resolveSettled!: () => void;
    settledPromise = new Promise((r) => { resolveSettled = r; });

    const pending = getEnabledSkillEntries();
    // 桥还没落定：list() 不该已经跑（走几个微任务，给"若提前跑"的错误实现机会暴露）
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(requestListSkills).not.toHaveBeenCalled();

    resolveSettled();
    await pending;
    expect(requestListSkills).toHaveBeenCalled();
  });
});
