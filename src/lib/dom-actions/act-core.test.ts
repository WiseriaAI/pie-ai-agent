import { describe, it, expect, beforeEach } from "vitest";
import { probePageInjected } from "./probe-core";
import { actByIdxInjected } from "./act-core";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("actByIdxInjected op=rect", () => {
  it("locates a stamped element inside an open shadow root (op=rect)", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button>deep</button>`;
    const btn = sr.querySelector("button") as HTMLElement;
    Object.defineProperty(btn, "getBoundingClientRect", {
      value: () => ({ x: 10, y: 20, width: 30, height: 40, top: 20, left: 10, right: 40, bottom: 60 }),
      configurable: true,
    });
    probePageInjected({ op: "snapshot" }); // stamps shadow-internal interactive els
    const idx = Number(btn.getAttribute("data-pie-idx"));
    expect(Number.isFinite(idx)).toBe(true);
    const r = await actByIdxInjected({ op: "rect", idx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("narrow");
    if (r.op !== "rect") throw new Error("narrow op");
    expect(r.rect).toMatchObject({ w: 30, h: 40 });
  });

  it("returns ok:false for a missing idx", async () => {
    document.body.innerHTML = `<button>visible</button>`;
    probePageInjected({ op: "snapshot" });
    const r = await actByIdxInjected({ op: "rect", idx: 9999 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toMatch(/not found|9999/i);
  });

  it("returns ok:true with rect for a normal (light DOM) element", async () => {
    document.body.innerHTML = `<button>click me</button>`;
    const btn = document.querySelector("button") as HTMLElement;
    Object.defineProperty(btn, "getBoundingClientRect", {
      value: () => ({ x: 5, y: 15, width: 100, height: 50, top: 15, left: 5, right: 105, bottom: 65 }),
      configurable: true,
    });
    probePageInjected({ op: "snapshot" });
    const idx = Number(btn.getAttribute("data-pie-idx"));
    expect(Number.isFinite(idx)).toBe(true);
    const r = await actByIdxInjected({ op: "rect", idx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("narrow");
    if (r.op !== "rect") throw new Error("narrow op");
    expect(r.rect).toMatchObject({ x: 5, y: 15, w: 100, h: 50 });
  });

});

describe("actByIdxInjected op=type", () => {
  it("writes into a stamped input value", async () => {
    document.body.innerHTML = `<input type="text" data-pie-idx="3" />`;
    const inp = document.querySelector("input") as HTMLInputElement;
    inp.getBoundingClientRect = () =>
      ({ width: 200, height: 30, top: 0, left: 0, right: 200, bottom: 30, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const r = await actByIdxInjected({ op: "type", idx: 3, text: "hello world", clear: false });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("narrow");
    if (r.op !== "type") throw new Error("narrow op");
    expect(r.observation).toContain("hello world");
    expect(inp.value).toBe("hello world");
  });

  it("writes into a stamped contenteditable", async () => {
    document.body.innerHTML = `<div contenteditable="true" data-pie-idx="4"></div>`;
    const div = document.querySelector("div") as HTMLElement;
    div.getBoundingClientRect = () =>
      ({ width: 200, height: 80, top: 0, left: 0, right: 200, bottom: 80, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const r = await actByIdxInjected({ op: "type", idx: 4, text: "rich text", clear: false });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("narrow");
    if (r.op !== "type") throw new Error("narrow op");
    expect((div.innerText || div.textContent || "")).toContain("rich text");
  });

  it("refuses a Monaco .inputarea (IME buffer) and routes to dispatch_keyboard_input", async () => {
    document.body.innerHTML = `
      <div class="monaco-editor">
        <div class="overflow-guard">
          <textarea class="inputarea" data-pie-idx="8"></textarea>
        </div>
      </div>`;
    const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
    // Monaco's .inputarea is full-size and opaque — it slips past any
    // size<24 / opacity<0.2 heuristic. Force a non-trivial box.
    ta.getBoundingClientRect = () =>
      ({ width: 300, height: 120, top: 0, left: 0, right: 300, bottom: 120, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const r = await actByIdxInjected({ op: "type", idx: 8, text: 'console.log("HelloPie");', clear: false });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toContain("dispatch_keyboard_input");
    expect(r.error).toContain("Monaco");
  });

  it("rejects a non-typeable element", async () => {
    document.body.innerHTML = `<button data-pie-idx="5">btn</button>`;
    const r = await actByIdxInjected({ op: "type", idx: 5, text: "x", clear: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toMatch(/not typeable/i);
  });

  it("redacts sensitive (password) field values in the observation", async () => {
    document.body.innerHTML = `<input type="password" name="password" data-pie-idx="6" />`;
    const inp = document.querySelector("input") as HTMLInputElement;
    inp.getBoundingClientRect = () =>
      ({ width: 200, height: 30, top: 0, left: 0, right: 200, bottom: 30, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const r = await actByIdxInjected({ op: "type", idx: 6, text: "s3cr3t", clear: false });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("narrow");
    if (r.op !== "type") throw new Error("narrow op");
    expect(r.observation).toContain("redacted");
    expect(r.observation).not.toContain("s3cr3t");
  });
});
