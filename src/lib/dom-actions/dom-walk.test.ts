import { describe, it, expect } from "vitest";
import { walkDeep, deepQuerySelectorAll, isVisibleDeep } from "./dom-walk";

describe("walkDeep", () => {
  it("yields elements in document order including the root element", () => {
    document.body.innerHTML = `<main><h1>A</h1><p>B</p></main>`;
    const tags = [...walkDeep(document.body)].map((e) => e.tagName.toLowerCase());
    expect(tags).toEqual(["body", "main", "h1", "p"]);
  });

  it("穿透 open shadow root", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button>Click</button>`;
    const tags = [...walkDeep(document.body)].map((e) => e.tagName.toLowerCase());
    expect(tags).toContain("button");
  });

  it("不穿透 closed shadow root", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<button>Hidden</button>`;
    const tags = [...walkDeep(document.body)].map((e) => e.tagName.toLowerCase());
    expect(tags).not.toContain("button");
  });

  it("递归处理嵌套 shadow root", () => {
    document.body.innerHTML = `<div id="outer"></div>`;
    const outer = document.getElementById("outer")!;
    const outerShadow = outer.attachShadow({ mode: "open" });
    outerShadow.innerHTML = `<div id="inner"></div>`;
    const inner = outerShadow.getElementById("inner")!;
    const innerShadow = inner.attachShadow({ mode: "open" });
    innerShadow.innerHTML = `<span>deep</span>`;
    const tags = [...walkDeep(document.body)].map((e) => e.tagName.toLowerCase());
    expect(tags).toContain("span");
  });

  it("不跨 iframe", () => {
    document.body.innerHTML = `<iframe id="f"></iframe>`;
    const f = document.getElementById("f") as HTMLIFrameElement;
    f.contentDocument!.body.innerHTML = `<button>inside</button>`;
    const tags = [...walkDeep(document.body)].map((e) => e.tagName.toLowerCase());
    expect(tags).toContain("iframe");
    expect(tags).not.toContain("button");
  });

  it("yields shadow content of root element itself", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button>inside</button>`;
    const tags = [...walkDeep(host)].map((e) => e.tagName.toLowerCase());
    expect(tags).toContain("button");
  });
});

describe("deepQuerySelectorAll", () => {
  it("跨 shadow root 匹配选择器", () => {
    document.body.innerHTML = `<div id="host"></div><button>top</button>`;
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button>inside</button>`;
    const buttons = deepQuerySelectorAll(document.body, "button");
    expect(buttons.map((b) => b.textContent)).toEqual(["top", "inside"]);
  });
});

describe("isVisibleDeep", () => {
  it("不可见 display:none 返回 false", () => {
    document.body.innerHTML = `<button style="display:none">X</button>`;
    const btn = document.querySelector("button")!;
    expect(isVisibleDeep(btn)).toBe(false);
  });

  it("opacity:0 的 input 返回 false（IME buffer 兼容）", () => {
    document.body.innerHTML = `<input style="opacity:0;width:100px;height:20px">`;
    const inp = document.querySelector("input")!;
    expect(isVisibleDeep(inp)).toBe(false);
  });

  it("normal visible element returns true", () => {
    document.body.innerHTML = `<button style="width:100px;height:30px">X</button>`;
    const btn = document.querySelector("button")!;
    expect(isVisibleDeep(btn)).toBe(true);
  });
});
