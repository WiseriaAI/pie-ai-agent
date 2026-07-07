import { describe, expect, it } from "vitest";
import { runScript, type ImportFn } from "./skill-sandbox";

// 真实路径用 blob URL 动态 import（vitest/happy-dom 跑不了）；测试注入 fake importFn。
const importOf =
  (mod: Record<string, unknown>): ImportFn =>
  async () => mod;

describe("runScript", () => {
  it("调 default(input) 并 JSON 序列化返回值", async () => {
    const fn = async (input: { a: number }) => ({ sum: input.a + 1 });
    expect(await runScript("code", { a: 41 }, importOf({ default: fn }))).toBe('{"sum":42}');
  });

  it('undefined 返回值 → "null"', async () => {
    expect(await runScript("code", null, importOf({ default: () => undefined }))).toBe("null");
  });

  it("default 不是函数 → 报错", async () => {
    await expect(runScript("code", null, importOf({ default: 42 }))).rejects.toThrow(
      /export default/,
    );
    await expect(runScript("code", null, importOf({}))).rejects.toThrow(/export default/);
  });

  it("import 失败 → 报 module 加载错", async () => {
    const bad: ImportFn = async () => {
      throw new Error("SyntaxError: nope");
    };
    await expect(runScript("code", null, bad)).rejects.toThrow(/failed to load as an ES module/);
  });

  it("脚本抛错 → 透传", async () => {
    const fn = () => {
      throw new Error("boom from script");
    };
    await expect(runScript("code", null, importOf({ default: fn }))).rejects.toThrow(
      /boom from script/,
    );
  });

  it("输出不可 JSON 序列化 → 报错", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      runScript("code", null, importOf({ default: () => circular })),
    ).rejects.toThrow(/not JSON-serializable/);
  });
});
