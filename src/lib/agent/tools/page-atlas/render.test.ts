import { describe, expect, it } from "vitest";
import { renderPageAtlas } from "./render";
import type { AtlasControl, AtlasTarget, PageAtlasState } from "./types";

function control(i: number, over: Partial<AtlasControl> = {}): AtlasControl {
  return {
    id: `ctrl_${i}`,
    frameId: 0,
    pieIdx: i,
    type: "link",
    label: `Link ${i}`,
    ...over,
  };
}

function target(i: number, over: Partial<AtlasTarget> = {}): AtlasTarget {
  return {
    id: `collection_c${i}`,
    type: "collection",
    label: `List ${i}`,
    frameId: 0,
    confidence: "high",
    summary: `${i} items`,
    ...over,
  };
}

function atlasOf(controls: AtlasControl[], targets: AtlasTarget[] = []): PageAtlasState {
  return {
    atlasId: "atlas_test",
    tabId: 7,
    url: "https://example.com/",
    origin: "https://example.com",
    title: "Example",
    createdAt: 0,
    fingerprint: {
      url: "https://example.com/",
      title: "Example",
      bodyTextLengthBucket: 0,
      interactiveCountBucket: 0,
      topSectionCount: 0,
    },
    targets,
    controls,
    forms: [],
    controlGroups: [],
    navigation: [],
  };
}

const countControls = (out: string) => out.split("<control ").length - 1;

describe("renderPageAtlas — 结果预算", () => {
  it("控件超上限时只渲染 top-K,并显式报告省略数", () => {
    const out = renderPageAtlas(atlasOf(Array.from({ length: 500 }, (_, i) => control(i))));

    expect(countControls(out)).toBe(40);
    expect(out).toContain('<omitted controls="460"');
    // 静默截断是明确要避免的:LLM 必须能看到还有多少、以及怎么捞回来。
    expect(out).toContain('mode:&quot;interactive&quot;');
  });

  it("没超上限时不渲染 omitted 元素", () => {
    const out = renderPageAtlas(atlasOf([control(0), control(1)]));
    expect(countControls(out)).toBe(2);
    expect(out).not.toContain("<omitted");
  });

  it("视口内控件与输入类控件优先入选,不靠 DOM 顺序", () => {
    const controls = [
      // 前 60 个是屏幕外的链接,按 DOM 顺序会把 top-40 全占掉。
      ...Array.from({ length: 60 }, (_, i) => control(i)),
      control(900, { type: "textbox", label: "Search", inView: true }),
      control(901, { type: "button", label: "Submit", inView: true }),
    ];
    const out = renderPageAtlas(atlasOf(controls));

    expect(out).toContain('pie_idx="900"');
    expect(out).toContain('pie_idx="901"');
    expect(countControls(out)).toBe(40);
  });

  // 回归:曾经有过一个按 label 子串过滤的 query 参数。LLM 传 query:"摘要" 而页面
  // 按钮叫「AI 总结」,零匹配 → 123 个控件全被滤掉 → 且 omitted 算的是「过滤后的
  // 池子」所以显示 0 → LLM 理解成「这页什么都没有」,转头去调更贵的 content 模式。
  // 这条锁住:omitted 永远相对**页面总量**,截断永远是可见的。
  it("omitted 反映页面总量,不会出现「什么都没有」的空壳", () => {
    const out = renderPageAtlas(atlasOf(Array.from({ length: 123 }, (_, i) => control(i))));
    expect(countControls(out)).toBe(40);
    expect(out).toContain('<omitted controls="83"');
    expect(countControls(out) + 83).toBe(123);
  });

  it("targets 同样受上限约束", () => {
    const out = renderPageAtlas(atlasOf([], Array.from({ length: 30 }, (_, i) => target(i))));
    expect(out.split("<target ").length - 1).toBe(20);
    expect(out).toContain('targets="10"');
  });

  it("同一 atlas 重复渲染逐字节一致(前缀缓存前提)", () => {
    const atlas = atlasOf(Array.from({ length: 200 }, (_, i) => control(i, { inView: i % 7 === 0 })));
    expect(renderPageAtlas(atlas)).toBe(renderPageAtlas(atlas));
  });
});
