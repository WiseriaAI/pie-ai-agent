import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/images/crop-bbox", () => ({
  cropBboxToJpegDataUrl: vi.fn(async () => "data:image/jpeg;base64,Y3JvcA=="),
}));

import {
  handleQuoteTextCaptured,
  handleQuoteElementCaptured,
  broadcastPickerEnter,
  broadcastPickerExit,
} from "./quote-bridge";

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 7, url: "https://example.com" })) as unknown as typeof chrome.tabs.get,
      captureVisibleTab: vi.fn(async () => "data:image/png;base64,xxxx"),
      sendMessage: vi.fn(),
    },
    runtime: { lastError: undefined },
  } as unknown as typeof chrome;
  vi.spyOn(crypto, "randomUUID").mockReturnValue("u-1" as `${string}-${string}-${string}-${string}-${string}`);
});

describe("QuoteBridge", () => {
  it("text capture → quote-added with stable id + sourceTabId", async () => {
    const sender = { tab: { id: 42 } } as chrome.runtime.MessageSender;
    const out = await handleQuoteTextCaptured(sender, {
      text: "hi",
      sourceUrl: "https://example.com",
    });
    expect(out).toEqual({
      type: "quote-added",
      quote: {
        id: "u-1",
        kind: "text",
        text: "hi",
        sourceUrl: "https://example.com",
        sourceTabId: 42,
      },
    });
  });

  it("text capture → null when sender.tab.id missing (W-3)", async () => {
    const out = await handleQuoteTextCaptured(
      {} as chrome.runtime.MessageSender,
      { text: "hi", sourceUrl: "x" },
    );
    expect(out).toBeNull();
  });

  it("element capture → quote-added with cropped image", async () => {
    const sender = { tab: { id: 42 } } as chrome.runtime.MessageSender;
    const out = await handleQuoteElementCaptured(sender, {
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      devicePixelRatio: 2,
      role: "button",
      accessibleName: "Create",
      textContent: "New issue",
      outerHTMLTruncated: "<button>New issue</button>",
      sourceUrl: "https://example.com",
    });
    expect(out?.quote.kind).toBe("element");
    if (out?.quote.kind !== "element") throw new Error("guard");
    expect(out.quote.imageDataUrl).toBe("data:image/jpeg;base64,Y3JvcA==");
    expect(out.quote.role).toBe("button");
  });

  it("element capture → imageDataUrl=null when captureVisibleTab throws", async () => {
    (chrome.tabs as unknown as { captureVisibleTab: unknown }).captureVisibleTab = vi.fn(async () => {
      throw new Error("Permission denied");
    });
    const sender = { tab: { id: 42 } } as chrome.runtime.MessageSender;
    const out = await handleQuoteElementCaptured(sender, {
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      devicePixelRatio: 1,
      role: "button",
      accessibleName: "x",
      textContent: "x",
      outerHTMLTruncated: "<x />",
      sourceUrl: "https://example.com",
    });
    expect(out?.quote.kind === "element" && out.quote.imageDataUrl).toBe(null);
  });

  it("broadcastPickerEnter → tabs.sendMessage", async () => {
    await broadcastPickerEnter(42);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: "picker:enter" });
  });

  it("broadcastPickerExit → tabs.sendMessage", async () => {
    await broadcastPickerExit(42);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: "picker:exit" });
  });
});
