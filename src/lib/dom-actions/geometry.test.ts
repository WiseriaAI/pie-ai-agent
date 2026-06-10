import { describe, it, expect, beforeEach, vi } from "vitest";
import { elementToPagePoint } from "./geometry";

beforeEach(() => {
  global.chrome = {
    scripting: {
      executeScript: vi.fn(),
    } as unknown as typeof chrome.scripting,
  } as unknown as typeof chrome;
});

describe("elementToPagePoint — top frame", () => {
  it("returns rect center", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { ok: true, op: "rect", rect: { x: 100, y: 200, w: 50, h: 40 } } },
    ]);
    const result = await elementToPagePoint(7, 3);
    expect(result).toEqual({ x: 125, y: 220 });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [0] } }),
    );
  });

  it("returns element-not-found when result is null", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([{ result: null }]);
    expect(await elementToPagePoint(7, 3)).toEqual({ kind: "element-not-found", index: 3 });
  });

  it("returns element-not-visible for zero-sized rect", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { ok: true, op: "rect", rect: { x: 0, y: 0, w: 0, h: 0 } } },
    ]);
    expect(await elementToPagePoint(7, 3)).toEqual({ kind: "element-not-visible", index: 3 });
  });
});
