import { describe, expect, it } from "vitest";
import { findScriptDecl, isPureCompute, parseScriptDecls } from "./script-decl";

describe("parseScriptDecls", () => {
  it("string 简写 → 纯计算声明", () => {
    expect(parseScriptDecls(["scripts/dedupe.js"])).toEqual([
      { entry: "scripts/dedupe.js", fs: false, network: [] },
    ]);
  });

  it("JSON flow 对象形 → 特权声明", () => {
    expect(
      parseScriptDecls(['{"entry": "scripts/fetch.js", "network": ["api.example.com"]}']),
    ).toEqual([{ entry: "scripts/fetch.js", fs: false, network: ["api.example.com"] }]);
  });

  it("fs: true 被解析", () => {
    expect(parseScriptDecls(['{"entry": "scripts/save.js", "fs": true}'])).toEqual([
      { entry: "scripts/save.js", fs: true, network: [] },
    ]);
  });

  it("坏 JSON / 缺 entry / 空串 / 非字符串项被静默丢弃", () => {
    expect(
      parseScriptDecls(['{"entry": ', '{"fs": true}', "", "  ", 42 as unknown as string]),
    ).toEqual([]);
  });

  it("network 里的非字符串项被过滤", () => {
    expect(parseScriptDecls(['{"entry": "a.js", "network": ["ok.com", 7]}'])).toEqual([
      { entry: "a.js", fs: false, network: ["ok.com"] },
    ]);
  });

  it("非数组输入 → []", () => {
    expect(parseScriptDecls(undefined)).toEqual([]);
    expect(parseScriptDecls("scripts/a.js")).toEqual([]);
  });
});

describe("findScriptDecl / isPureCompute", () => {
  const decls = parseScriptDecls([
    "scripts/pure.js",
    '{"entry": "scripts/priv.js", "network": ["api.example.com"]}',
  ]);
  it("按 entry 精确查找", () => {
    expect(findScriptDecl(decls, "scripts/pure.js")?.entry).toBe("scripts/pure.js");
    expect(findScriptDecl(decls, "scripts/nope.js")).toBeUndefined();
  });
  it("isPureCompute：无 fs 无 network 才是纯计算", () => {
    expect(isPureCompute(decls[0])).toBe(true);
    expect(isPureCompute(decls[1])).toBe(false);
    expect(isPureCompute({ entry: "x", fs: true, network: [] })).toBe(false);
  });
});
