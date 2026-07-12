import { describe, it, expect } from "vitest";
import { filterEnabled, type SkillEntry } from "./source";

function entry(over: Partial<SkillEntry>): SkillEntry {
  return {
    id: "x",
    name: "x",
    description: "d",
    builtIn: false,
    origin: "disk",
    files: [],
    runnableScripts: [],
    ...over,
  };
}

describe("filterEnabled 多根默认规则", () => {
  it("主根磁盘 skill（source: pie）默认开", () => {
    expect(filterEnabled([entry({ id: "a", source: "pie" })], [])).toHaveLength(1);
  });

  it("磁盘 skill 无 source（旧 daemon）默认开", () => {
    expect(filterEnabled([entry({ id: "a" })], [])).toHaveLength(1);
  });

  it("副根 skill（source: agents）默认关", () => {
    expect(filterEnabled([entry({ id: "a", source: "agents" })], [])).toHaveLength(0);
  });

  it("副根 skill 有 plain marker → 开", () => {
    expect(filterEnabled([entry({ id: "a", source: "agents" })], ["a"])).toHaveLength(1);
  });

  it("副根 skill 有 !marker → 关", () => {
    expect(filterEnabled([entry({ id: "a", source: "agents" })], ["!a"])).toHaveLength(0);
  });

  it("IDB 用户 skill 仍默认关（回归）", () => {
    expect(filterEnabled([entry({ id: "a", origin: "idb" })], [])).toHaveLength(0);
  });
});
