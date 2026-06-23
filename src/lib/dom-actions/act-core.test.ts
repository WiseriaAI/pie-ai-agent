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

  it("routes a type aimed at a Monaco editor surface (non-typeable div) to the editor tools", async () => {
    document.body.innerHTML = `
      <div class="monaco-editor">
        <div class="view-line" data-pie-idx="20">const x = 1;</div>
      </div>`;
    const r = await actByIdxInjected({ op: "type", idx: 20, text: "y", clear: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toContain("Monaco");
    expect(r.error).toMatch(/read_editor|dispatch_keyboard_input/);
  });

  it("routes a type aimed at a bare <canvas> to screenshot + keyboard tools", async () => {
    document.body.innerHTML = `<canvas data-pie-idx="21"></canvas>`;
    const r = await actByIdxInjected({ op: "type", idx: 21, text: "y", clear: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toMatch(/canvas/i);
    expect(r.error).toMatch(/dispatch_keyboard_input|screenshot|vision/);
  });

  it("keeps the generic not-typeable message for a plain non-editor element", async () => {
    document.body.innerHTML = `<p data-pie-idx="22">just text</p>`;
    const r = await actByIdxInjected({ op: "type", idx: 22, text: "y", clear: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toMatch(/not typeable/i);
    expect(r.error).not.toMatch(/dispatch_keyboard_input/);
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

  it("derives the field name from a label[for] association (getFieldName label-for path)", async () => {
    // password input has no name attr, so getFieldName falls through to the
    // label[for="pw"] lookup. (It's sensitive, so the value is redacted but
    // the resolved field name still surfaces.)
    document.body.innerHTML = `<label for="pw">Password</label><input id="pw" type="password" data-pie-idx="7" />`;
    const inp = document.querySelector("input") as HTMLInputElement;
    inp.getBoundingClientRect = () =>
      ({ width: 200, height: 30, top: 0, left: 0, right: 200, bottom: 30, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const r = await actByIdxInjected({ op: "type", idx: 7, text: "hunter2", clear: false });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("narrow");
    if (r.op !== "type") throw new Error("narrow op");
    expect(r.observation).toContain("Password");
  });
});

describe("actByIdxInjected op=select", () => {
  it("selects a valid option in a <select> element", async () => {
    document.body.innerHTML = `
      <select>
        <option value="a">Apple</option>
        <option value="b">Banana</option>
        <option value="c">Cherry</option>
      </select>`;
    probePageInjected({ op: "snapshot" });
    const sel = document.querySelector("select") as HTMLSelectElement;
    const idx = Number(sel.getAttribute("data-pie-idx"));
    expect(Number.isFinite(idx)).toBe(true);
    let changed = false;
    sel.addEventListener("change", () => { changed = true; });

    const r = await actByIdxInjected({ op: "select", idx, value: "b" });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("narrow");
    if (r.op !== "select") throw new Error("narrow op");
    expect(r.observation).toContain("Banana");
    expect(r.observation).toContain('"b"');
    expect(sel.value).toBe("b");
    expect(changed).toBe(true);
  });

  it("rejects a non-<select> element", async () => {
    document.body.innerHTML = `<input type="text" />`;
    probePageInjected({ op: "snapshot" });
    const inp = document.querySelector("input") as HTMLInputElement;
    const idx = Number(inp.getAttribute("data-pie-idx"));

    const r = await actByIdxInjected({ op: "select", idx, value: "x" });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toMatch(/not a <select>/i);
  });

  it("rejects a missing option and lists available values", async () => {
    document.body.innerHTML = `
      <select>
        <option value="x">X</option>
        <option value="y">Y</option>
      </select>`;
    probePageInjected({ op: "snapshot" });
    const sel = document.querySelector("select") as HTMLSelectElement;
    const idx = Number(sel.getAttribute("data-pie-idx"));

    const r = await actByIdxInjected({ op: "select", idx, value: "z" });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toContain('"z"');
    expect(r.error).toContain('"x"');
    expect(r.error).toContain('"y"');
  });
});

describe("actByIdxInjected op=focusClick", () => {
  it("focusClick clicks the located element", async () => {
    document.body.innerHTML = `<button>go</button>`;
    probePageInjected({ op: "snapshot" });
    const btn = document.querySelector("button") as HTMLElement;
    const idx = Number(btn.getAttribute("data-pie-idx"));
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    const r = await actByIdxInjected({ op: "focusClick", idx });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("narrow");
    if (r.op !== "focusClick") throw new Error("narrow op");
    expect(r.observation).toContain("Focus-clicked");
    expect(clicked).toBe(true);
  });
});

describe("actByIdxInjected op=click", () => {
  it("dispatches press/release sequence ending with native click", async () => {
    document.body.innerHTML = `<button data-pie-idx="3">Go</button>`;
    const el = document.querySelector("button")!;
    const seen: string[] = [];
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.addEventListener(t, () => seen.push(t));
    }
    const result = await actByIdxInjected({ op: "click", idx: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrow");
    if (result.op !== "click") throw new Error("narrow op");
    expect(result.observation).toContain("Clicked element [3]");
    expect(seen).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  });

  it("focuses a focusable element before clicking", async () => {
    document.body.innerHTML = `<input data-pie-idx="5" type="checkbox" />`;
    const el = document.querySelector("input")!;
    await actByIdxInjected({ op: "click", idx: 5 });
    expect(document.activeElement).toBe(el);
    expect(el.checked).toBe(true); // native click() toggles the checkbox
  });

  it("locates elements inside open shadow roots", async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button data-pie-idx="9">Inner</button>`;
    let clicked = false;
    sr.querySelector("button")!.addEventListener("click", () => { clicked = true; });
    const result = await actByIdxInjected({ op: "click", idx: 9 });
    expect(result.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it("returns ok:false for a missing idx", async () => {
    document.body.innerHTML = `<div></div>`;
    const result = await actByIdxInjected({ op: "click", idx: 404 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });

  it("returns ok:false for a disabled element without firing click", async () => {
    document.body.innerHTML = `<button data-pie-idx="7" disabled>Nope</button>`;
    let clicked = false;
    document.querySelector("button")!.addEventListener("click", () => { clicked = true; });
    const result = await actByIdxInjected({ op: "click", idx: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("disabled");
    expect(clicked).toBe(false);
  });
});
