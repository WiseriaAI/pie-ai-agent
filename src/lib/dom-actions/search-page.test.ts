import { describe, it, expect, beforeEach, vi } from "vitest";
import { searchPageInjected, type SearchPageParams } from "./search-page";
import { pageSnapshotInjected } from "./page-snapshot";

function run(overrides: Partial<SearchPageParams>) {
  const params: SearchPageParams = {
    queries: [],
    regex: false,
    mode: "all",
    maxResults: 10,
    searchBy: "text",
    ...overrides,
  };
  return searchPageInjected(params);
}

describe("searchPageInjected", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document
      .querySelectorAll("[data-pie-idx]")
      .forEach((el) => el.removeAttribute("data-pie-idx"));
  });

  it("子串命中,返回 matched + snippet + tag", () => {
    document.body.innerHTML = `<p>our refund policy is generous</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.total).toBe(1);
    expect(r.matches[0].matched).toBe("refund");
    expect(r.matches[0].snippet).toContain("refund");
    expect(r.matches[0].tag).toBe("p");
  });

  it("大小写不敏感", () => {
    document.body.innerHTML = `<p>REFUND here</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.total).toBe(1);
  });

  it("多 query OR — 命中任一即算", () => {
    document.body.innerHTML = `<p>about price</p><div>refund desk</div>`;
    const r = run({ queries: ["refund", "price"] });
    expect(r.total).toBe(2);
  });

  it("命中在可交互元素 → pie_idx 非空 + 等于 read_page 的盖号", () => {
    document.body.innerHTML = `<button>refund</button>`;
    const r = run({ queries: ["refund"] });
    expect(r.matches[0].pieIdx).toBe(0);
  });

  it("命中在普通文本 → pie_idx 为 null", () => {
    document.body.innerHTML = `<p>refund</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.matches[0].pieIdx).toBeNull();
  });

  it("文本在不可交互子元素里 → 锚到最近可交互祖先", () => {
    document.body.innerHTML = `<button><span>refund</span></button>`;
    const r = run({ queries: ["refund"] });
    expect(r.matches[0].pieIdx).toBe(0);
  });

  it("同元素多次出现 → 只产出一条", () => {
    document.body.innerHTML = `<p>refund refund refund</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.total).toBe(1);
    expect(r.matches.length).toBe(1);
  });

  it("穿透 open shadow root 搜索 + 锚 idx", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const shadow = document
      .getElementById("host")!
      .attachShadow({ mode: "open" });
    shadow.innerHTML = `<button>shadow-refund</button>`;
    const r = run({ queries: ["shadow-refund"] });
    expect(r.total).toBe(1);
    expect(r.matches[0].pieIdx).not.toBeNull();
  });

  it("snippet 长文本两端加省略号", () => {
    const long = "x".repeat(200) + "refund" + "y".repeat(200);
    document.body.innerHTML = `<p>${long}</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.matches[0].snippet.startsWith("…")).toBe(true);
    expect(r.matches[0].snippet.endsWith("…")).toBe(true);
    expect(r.matches[0].snippet).toContain("refund");
  });

  it("text search filters wrapper and self-closing tag-shaped markup from snippet and matched", () => {
    const p = document.createElement("p");
    p.textContent = "before <untrusted_page_match/> after";
    document.body.appendChild(p);

    const r = run({ queries: ["<untrusted_page_match\\s*/>"], regex: true });

    expect(r.total).toBe(1);
    expect(r.matches[0].matched).toBe("[filtered]");
    expect(r.matches[0].snippet).toContain("[filtered]");
    expect(r.matches[0].matched).not.toContain("<untrusted_page_match");
    expect(r.matches[0].snippet).not.toContain("<untrusted_page_match");
  });

  it("text search removes control and zero-width chars from snippet and matched", () => {
    const p = document.createElement("p");
    p.textContent = "before re\u200bf\u0007und after";
    document.body.appendChild(p);

    const r = run({ queries: ["re.f.und"], regex: true });

    expect(r.total).toBe(1);
    expect(r.matches[0].matched).toBe("refund");
    expect(r.matches[0].snippet).toContain("refund");
    expect(r.matches[0].matched).not.toContain("\u200b");
    expect(r.matches[0].matched).not.toContain("\u0007");
    expect(r.matches[0].snippet).not.toContain("\u200b");
    expect(r.matches[0].snippet).not.toContain("\u0007");
  });

  it("text search caps long regex and literal matched strings after sanitization", () => {
    const literal = "x".repeat(120);
    document.body.innerHTML = `<p>${literal}</p>`;
    const literalResult = run({ queries: [literal] });

    expect(literalResult.total).toBe(1);
    expect(literalResult.matches[0].matched).toHaveLength(80);
    expect(literalResult.matches[0].snippet.length).toBeLessThanOrEqual(242);

    const regexText = "y".repeat(120);
    document.body.innerHTML = `<p>${regexText}</p>`;
    const regexResult = run({ queries: ["y{120}"], regex: true });

    expect(regexResult.total).toBe(1);
    expect(regexResult.matches[0].matched).toHaveLength(80);
    expect(regexResult.matches[0].snippet.length).toBeLessThanOrEqual(242);
  });

  it("mode=interactive 只回 pie_idx 非空命中", () => {
    document.body.innerHTML = `<button>refund btn</button><p>refund text</p>`;
    const r = run({ queries: ["refund"], mode: "interactive" });
    expect(r.matches.every((m) => m.pieIdx !== null)).toBe(true);
    expect(r.matches.length).toBe(1);
  });

  it("mode=text 只回 pie_idx 为空命中", () => {
    document.body.innerHTML = `<button>refund btn</button><p>refund text</p>`;
    const r = run({ queries: ["refund"], mode: "text" });
    expect(r.matches.every((m) => m.pieIdx === null)).toBe(true);
    expect(r.matches.length).toBe(1);
  });

  it("maxResults 截断 matches 但 total 报全量", () => {
    document.body.innerHTML = `<p>refund a</p><p>refund b</p><p>refund c</p>`;
    const r = run({ queries: ["refund"], maxResults: 1 });
    expect(r.total).toBe(3);
    expect(r.matches.length).toBe(1);
  });

  it("regex 命中,matched 是实际匹配文本", () => {
    document.body.innerHTML = `<p>refund</p>`;
    const r = run({ queries: ["ref.nd"], regex: true });
    expect(r.total).toBe(1);
    expect(r.matches[0].matched).toBe("refund");
  });

  it("regex 大小写不敏感(gi)", () => {
    document.body.innerHTML = `<p>REFUND</p>`;
    const r = run({ queries: ["ref.nd"], regex: true });
    expect(r.total).toBe(1);
  });

  it("无效 regex 返回 invalidRegex,不抛", () => {
    document.body.innerHTML = `<p>refund</p>`;
    const r = run({ queries: ["("], regex: true });
    expect(r.invalidRegex).toBeTruthy();
    expect(r.matches.length).toBe(0);
  });

  it("能匹配空串的 regex(a*) 不死循环", () => {
    document.body.innerHTML = `<p>bbb</p>`;
    const r = run({ queries: ["a*"], regex: true });
    expect(r.invalidRegex).toBeNull();
    expect(r.total).toBe(0);
  });

  it("超时预算触发 timedOut", () => {
    document.body.innerHTML = `<p>refund a</p><p>refund b</p>`;
    const spy = vi.spyOn(performance, "now");
    spy.mockReturnValueOnce(0).mockReturnValue(2000); // startTime=0, loop checks see 2000 (>1500)
    const r = run({ queries: ["refund"] });
    expect(r.timedOut).toBe(true);
    spy.mockRestore();
  });

  it("无命中返回空 + total 0", () => {
    document.body.innerHTML = `<p>nothing here</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.total).toBe(0);
    expect(r.matches.length).toBe(0);
  });

  it("searchBy=role finds a blank contenteditable textbox", () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true"></div>`;
    const ed = document.getElementById("ed") as HTMLElement;
    Object.defineProperty(ed, "getBoundingClientRect", {
      value: () => ({ width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40 }),
      configurable: true,
    });

    const r = run({ queries: ["textbox"], searchBy: "role", mode: "interactive" });

    expect(r.total).toBe(1);
    expect(r.matches[0]).toEqual(expect.objectContaining({
      pieIdx: 0,
      tag: "div",
      role: "textbox",
      contenteditable: true,
      matched: "textbox",
    }));
  });

  it("searchBy=tag supports virtual contenteditable tag", () => {
    document.body.innerHTML = `<section><div contenteditable="true"></div></section>`;
    const r = run({ queries: ["contenteditable"], searchBy: "tag", mode: "interactive" });
    expect(r.total).toBe(1);
    expect(r.matches[0].matched).toBe("contenteditable");
  });

  it("searchBy=attribute supports allowlisted contenteditable=true", () => {
    document.body.innerHTML = `<div contenteditable="true"></div><button>Send</button>`;
    const r = run({ queries: ["contenteditable=true"], searchBy: "attribute", mode: "interactive" });
    expect(r.total).toBe(1);
    expect(r.matches[0].tag).toBe("div");
  });

  it("searchBy=attribute rejects unsupported attribute queries without throwing", () => {
    document.body.innerHTML = `<div data-secret="x"></div>`;
    const r = run({ queries: ["data-secret=x"], searchBy: "attribute" });
    expect(r.invalidAttribute).toMatch(/unsupported_attribute/);
    expect(r.total).toBe(0);
  });

  it("searchBy=attribute rejects empty attribute values without broad matching", () => {
    document.body.innerHTML = `<p>Plain</p><button>Send</button>`;
    const r = run({ queries: ["role="], searchBy: "attribute" });
    expect(r.invalidAttribute).toMatch(/invalid_attribute_query/);
    expect(r.total).toBe(0);
  });
});

describe("search finds label-rescued hidden controls", () => {
  it("returns the rescued label's pie_idx for a hidden toggle", () => {
    document.body.innerHTML = `
      <div class="switch">
        <input type="checkbox" id="st" name="product[status]" checked>
        <label class="lbl" for="st">Enable Product</label>
      </div>`;
    const cb = document.getElementById("st") as HTMLInputElement;
    Object.defineProperty(cb, "getBoundingClientRect", {
      value: () => ({ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }),
      configurable: true,
    });

    const r = run({ queries: ["Enable Product"], mode: "all" });
    const hit = r.matches.find((m) => /Enable Product/i.test(m.snippet));
    expect(hit).toBeDefined();
    expect(hit!.pieIdx).toBe(0); // the rescued label carries pie_idx 0
  });
});

describe("search_page ↔ read_page idx parity (cross-layer regression)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document
      .querySelectorAll("[data-pie-idx]")
      .forEach((el) => el.removeAttribute("data-pie-idx"));
  });

  it("两个注入函数盖出的 idx→element 映射相同", () => {
    document.body.innerHTML = `
      <h1>Title</h1>
      <button id="b0">A</button>
      <a id="a1" href="/x">B</a>
      <input id="i2" type="text">
      <p>plain text refund</p>
      <div id="host"></div>
    `;
    const shadow = document
      .getElementById("host")!
      .attachShadow({ mode: "open" });
    shadow.innerHTML = `<button id="sb">S</button>`;

    // read_page stamps first
    pageSnapshotInjected();
    const fromRead = new Map<string, string | null>();
    for (const id of ["b0", "a1", "i2"]) {
      fromRead.set(id, document.getElementById(id)!.getAttribute("data-pie-idx"));
    }
    fromRead.set("sb", shadow.getElementById("sb")!.getAttribute("data-pie-idx"));

    // search_page re-stamps (clears + restamps with the copied algorithm)
    searchPageInjected({ queries: ["refund"], regex: false, mode: "all", maxResults: 10, searchBy: "text" });
    for (const id of ["b0", "a1", "i2"]) {
      expect(document.getElementById(id)!.getAttribute("data-pie-idx")).toBe(
        fromRead.get(id),
      );
    }
    expect(shadow.getElementById("sb")!.getAttribute("data-pie-idx")).toBe(
      fromRead.get("sb"),
    );
  });
});
