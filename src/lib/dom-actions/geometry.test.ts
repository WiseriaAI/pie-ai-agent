import { describe, it, expect, beforeEach, vi } from "vitest";
import { elementToPagePoint, readRectByIdx } from "./geometry";

beforeEach(() => {
  // @ts-expect-error mock
  global.chrome = {
    scripting: {
      executeScript: vi.fn(),
    },
  };
});

describe("elementToPagePoint — top frame", () => {
  it("returns rect center for frameId=0", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { x: 100, y: 200, w: 50, h: 40 } },
    ]);
    const result = await elementToPagePoint(7, 0, 3);
    expect(result).toEqual({ x: 125, y: 220 });
  });

  it("returns element-not-found error when result is null", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([{ result: null }]);
    const result = await elementToPagePoint(7, 0, 3);
    expect(result).toEqual({ kind: "element-not-found", index: 3 });
  });

  it("returns element-not-visible error when rect is zero-sized", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { x: 0, y: 0, w: 0, h: 0 } },
    ]);
    const result = await elementToPagePoint(7, 0, 3);
    expect(result).toEqual({ kind: "element-not-visible", index: 3 });
  });

  it("returns frame-gone error when executeScript throws frame-not-found", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("No frame with id 42"),
    );
    const result = await elementToPagePoint(7, 42, 3);
    expect(result).toEqual({ kind: "frame-gone", frameId: 42 });
  });
});

describe("readRectByIdx (injected fn)", () => {
  it("returns null when element absent", () => {
    document.body.innerHTML = "";
    const result = readRectByIdx(5);
    expect(result).toBe(null);
  });

  it("returns rect when element present", () => {
    document.body.innerHTML = `<button data-pie-idx="5">x</button>`;
    const el = document.querySelector('[data-pie-idx="5"]') as HTMLElement;
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ x: 10, y: 20, width: 30, height: 40, top: 20, left: 10, bottom: 60, right: 40 }),
    });
    const result = readRectByIdx(5);
    expect(result).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
});
