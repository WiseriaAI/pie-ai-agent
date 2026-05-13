import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAllFramesAndDiff, inferUnreachableReason } from "./frame-discovery";

beforeEach(() => {
  const webNav = {
    getAllFrames: vi.fn(),
  };
  // @ts-expect-error chrome global is provided by test setup
  globalThis.chrome = { ...globalThis.chrome, webNavigation: webNav };
});

describe("inferUnreachableReason", () => {
  it("returns extension-child for chrome-extension:// URLs", () => {
    expect(inferUnreachableReason({ url: "chrome-extension://abc/x", errorOccurred: false })).toBe(
      "extension-child",
    );
  });

  it("returns about-blank for about:blank without error", () => {
    expect(inferUnreachableReason({ url: "about:blank", errorOccurred: false })).toBe("about-blank");
  });

  it("returns frame-error when errorOccurred=true", () => {
    expect(inferUnreachableReason({ url: "https://example.com/", errorOccurred: true })).toBe(
      "frame-error",
    );
  });

  it("returns sandbox as catch-all", () => {
    expect(inferUnreachableReason({ url: "https://example.com/sandboxed", errorOccurred: false })).toBe(
      "sandbox",
    );
  });
});

describe("getAllFramesAndDiff", () => {
  it("composes reachable frames from injection results in DOM order", async () => {
    // @ts-expect-error chrome mock
    chrome.webNavigation.getAllFrames.mockResolvedValueOnce([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/", errorOccurred: false },
      { frameId: 3, parentFrameId: 0, url: "https://embed.com/", errorOccurred: false },
    ]);

    const injections = [
      { frameId: 0, result: { url: "https://example.com/", title: "Top", elements: [], semantic: { headings: [], alerts: [], status: [] } } },
      { frameId: 3, result: { url: "https://embed.com/", title: "Embed", elements: [], semantic: { headings: [], alerts: [], status: [] } } },
    ];

    const frames = await getAllFramesAndDiff(42, injections);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      frameId: 0,
      frameUrl: "https://example.com/",
      crossOrigin: false,
      parentFrameId: null,
    });
    expect(frames[1]).toMatchObject({
      frameId: 3,
      frameUrl: "https://embed.com/",
      crossOrigin: true,
      parentFrameId: 0,
    });
  });

  it("marks frames missing from injection results as unreachable", async () => {
    // @ts-expect-error chrome mock
    chrome.webNavigation.getAllFrames.mockResolvedValueOnce([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/", errorOccurred: false },
      { frameId: 7, parentFrameId: 0, url: "https://sandboxed.com/", errorOccurred: false },
    ]);

    const injections = [
      { frameId: 0, result: { url: "https://example.com/", title: "Top", elements: [], semantic: { headings: [], alerts: [], status: [] } } },
      // frameId 7 missing — sandboxed iframe injection silently dropped
    ];

    const frames = await getAllFramesAndDiff(42, injections);
    expect(frames).toHaveLength(2);
    const sandboxed = frames.find((f) => f.frameId === 7);
    expect(sandboxed).toMatchObject({
      frameId: 7,
      frameUrl: "https://sandboxed.com/",
      unreachable: true,
      reason: "sandbox",
    });
  });

  it("computes crossOrigin against top frame origin", async () => {
    // @ts-expect-error chrome mock
    chrome.webNavigation.getAllFrames.mockResolvedValueOnce([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/page", errorOccurred: false },
      { frameId: 1, parentFrameId: 0, url: "https://example.com/embed", errorOccurred: false },
      { frameId: 2, parentFrameId: 0, url: "https://other.com/embed", errorOccurred: false },
    ]);

    const injections = [
      { frameId: 0, result: { url: "https://example.com/page", title: "T", elements: [], semantic: { headings: [], alerts: [], status: [] } } },
      { frameId: 1, result: { url: "https://example.com/embed", title: "T1", elements: [], semantic: { headings: [], alerts: [], status: [] } } },
      { frameId: 2, result: { url: "https://other.com/embed", title: "T2", elements: [], semantic: { headings: [], alerts: [], status: [] } } },
    ];

    const frames = await getAllFramesAndDiff(42, injections);
    const f0 = frames.find((f) => f.frameId === 0);
    const f1 = frames.find((f) => f.frameId === 1);
    const f2 = frames.find((f) => f.frameId === 2);
    expect(f0?.crossOrigin).toBe(false);  // top
    expect(f1?.crossOrigin).toBe(false);  // same origin as top
    expect(f2?.crossOrigin).toBe(true);   // different origin
  });

  it("returns empty array when getAllFrames returns null (detached tab)", async () => {
    // @ts-expect-error chrome mock
    chrome.webNavigation.getAllFrames.mockResolvedValueOnce(null);
    const frames = await getAllFramesAndDiff(42, []);
    expect(frames).toEqual([]);
  });

  it("infers about-blank reason for unreachable about:blank frame", async () => {
    // @ts-expect-error chrome mock
    chrome.webNavigation.getAllFrames.mockResolvedValueOnce([
      { frameId: 0, parentFrameId: -1, url: "https://example.com/", errorOccurred: false },
      { frameId: 5, parentFrameId: 0, url: "about:blank", errorOccurred: false },
    ]);

    const injections = [
      { frameId: 0, result: { url: "https://example.com/", title: "T", elements: [], semantic: { headings: [], alerts: [], status: [] } } },
    ];

    const frames = await getAllFramesAndDiff(42, injections);
    const aboutBlank = frames.find((f) => f.frameId === 5);
    expect(aboutBlank).toMatchObject({ unreachable: true, reason: "about-blank" });
  });
});
