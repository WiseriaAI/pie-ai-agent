import { describe, it, expect, beforeEach, vi } from "vitest";
import { elementToPagePoint, readRectByIdx, resolveChromeToCdpFrameId } from "./geometry";

beforeEach(() => {
  global.chrome = {
    scripting: {
      executeScript: vi.fn(),
    } as unknown as typeof chrome.scripting,
  } as unknown as typeof chrome;
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

describe("resolveChromeToCdpFrameId", () => {
  beforeEach(() => {
    global.chrome = {
      ...global.chrome,
      webNavigation: {
        getAllFrames: vi.fn(),
      } as unknown as typeof chrome.webNavigation,
    } as unknown as typeof chrome;
  });

  it("returns the matching CDP frame id by URL + parent chain", async () => {
    (chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: "https://top.test/" },
      { frameId: 42, parentFrameId: 0, url: "https://child.test/iframe" },
    ]);
    const cdpFrameTree = {
      frame: { id: "F-top", url: "https://top.test/" },
      childFrames: [
        { frame: { id: "F-child", url: "https://child.test/iframe", parentId: "F-top" } },
      ],
    };
    const result = await resolveChromeToCdpFrameId(7, 42, cdpFrameTree);
    expect(result).toBe("F-child");
  });

  it("returns null when no matching frame", async () => {
    (chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: "https://top.test/" },
    ]);
    const cdpFrameTree = { frame: { id: "F-top", url: "https://top.test/" }, childFrames: [] };
    const result = await resolveChromeToCdpFrameId(7, 99, cdpFrameTree);
    expect(result).toBe(null);
  });

  it("disambiguates same-URL siblings by DOM order", async () => {
    (chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: "https://top.test/" },
      { frameId: 10, parentFrameId: 0, url: "https://same.test/" },
      { frameId: 11, parentFrameId: 0, url: "https://same.test/" },
    ]);
    const cdpFrameTree = {
      frame: { id: "F-top", url: "https://top.test/" },
      childFrames: [
        { frame: { id: "F-1", url: "https://same.test/", parentId: "F-top" } },
        { frame: { id: "F-2", url: "https://same.test/", parentId: "F-top" } },
      ],
    };
    expect(await resolveChromeToCdpFrameId(7, 10, cdpFrameTree)).toBe("F-1");
    expect(await resolveChromeToCdpFrameId(7, 11, cdpFrameTree)).toBe("F-2");
  });
});

describe("elementToPagePoint — iframe", () => {
  beforeEach(() => {
    global.chrome = {
      ...global.chrome,
      scripting: { executeScript: vi.fn() } as unknown as typeof chrome.scripting,
      webNavigation: { getAllFrames: vi.fn() } as unknown as typeof chrome.webNavigation,
    } as unknown as typeof chrome;
  });

  it("accumulates iframe origin + frame-local rect center", async () => {
    // executeScript returns frame-local rect (inside iframe)
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { x: 20, y: 30, w: 10, h: 20 } },
    ]);
    (chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: "https://top.test/" },
      { frameId: 42, parentFrameId: 0, url: "https://child.test/iframe" },
    ]);

    // Mock CDP session module
    const sendMock = vi.fn().mockImplementation((method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: { id: "F-top", url: "https://top.test/" },
            childFrames: [{ frame: { id: "F-child", url: "https://child.test/iframe", parentId: "F-top" } }],
          },
        });
      }
      if (method === "DOM.getNodeForFrameOwner") {
        return Promise.resolve({ nodeId: 99 });
      }
      if (method === "DOM.getBoxModel") {
        return Promise.resolve({
          model: { content: [200, 300, 600, 300, 600, 500, 200, 500] },
        });
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    });

    const result = await elementToPagePoint(7, 42, 3, {
      send: sendMock as never,
      tabId: 7,
      ownerToken: { sessionId: "S1", tabId: 7 },
      generationId: 1,
      isAlive: true,
      detachedReason: null,
      detach: vi.fn(),
    });

    // iframe top-left = (200, 300); frame-local rect center = (25, 40); sum = (225, 340)
    expect(result).toEqual({ x: 225, y: 340 });
  });

  it("returns cdp-frame-id-unresolved when CDP tree has no match", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { x: 0, y: 0, w: 10, h: 10 } },
    ]);
    (chrome.webNavigation.getAllFrames as ReturnType<typeof vi.fn>).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: "https://top.test/" },
      { frameId: 42, parentFrameId: 0, url: "https://child.test/iframe" },
    ]);
    const sendMock = vi.fn().mockImplementation((method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({ frameTree: { frame: { id: "F-top", url: "https://top.test/" }, childFrames: [] } });
      }
      throw new Error(`Unexpected: ${method}`);
    });
    const result = await elementToPagePoint(7, 42, 3, {
      send: sendMock as never,
      tabId: 7,
      ownerToken: { sessionId: "S1", tabId: 7 },
      generationId: 1,
      isAlive: true,
      detachedReason: null,
      detach: vi.fn(),
    });
    expect(result).toEqual({ kind: "cdp-frame-id-unresolved", frameId: 42 });
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
