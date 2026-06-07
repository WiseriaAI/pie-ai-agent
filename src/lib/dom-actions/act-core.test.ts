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

  it("returns ok:false with unimplemented op for type (stub)", async () => {
    document.body.innerHTML = `<input type="text" />`;
    const inp = document.querySelector("input") as HTMLElement;
    Object.defineProperty(inp, "getBoundingClientRect", {
      value: () => ({ x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 }),
      configurable: true,
    });
    probePageInjected({ op: "snapshot" });
    const idx = Number(inp.getAttribute("data-pie-idx"));
    expect(Number.isFinite(idx)).toBe(true);
    const r = await actByIdxInjected({ op: "type", idx, text: "hello", clear: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.error).toMatch(/unimplemented/i);
  });
});
