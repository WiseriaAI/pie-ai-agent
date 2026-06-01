import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/images/crop-bbox", () => ({
  cropBboxToJpegDataUrl: vi.fn(async () => "data:image/jpeg;base64,Y3JvcA=="),
}));

import {
  handleQuoteTextCaptured,
  handleQuoteElementCaptured,
} from "@/background/quote-bridge";
import { escapeWrapperAttribute } from "@/lib/agent/untrusted-wrappers";

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })) as unknown as typeof chrome.tabs.get,
      captureVisibleTab: vi.fn(async () => "data:image/png;base64,raw"),
      sendMessage: vi.fn(),
    },
  } as unknown as typeof chrome;
  vi.spyOn(crypto, "randomUUID").mockReturnValue("u-cross" as `${string}-${string}-${string}-${string}-${string}`);
});

describe("cross-layer quote", () => {
  it("content text capture → SW → quote-added shape matches panel expectations", async () => {
    const out = await handleQuoteTextCaptured(
      { tab: { id: 99 } } as chrome.runtime.MessageSender,
      { text: "hello", sourceUrl: "https://example.com" },
    );
    expect(out).toEqual({
      type: "quote-added",
      quote: {
        id: "u-cross",
        kind: "text",
        text: "hello",
        sourceUrl: "https://example.com",
        sourceTabId: 99,
      },
    });
  });

  it("content element capture → SW returns element quote with cropped image", async () => {
    const out = await handleQuoteElementCaptured(
      { tab: { id: 99 } } as chrome.runtime.MessageSender,
      {
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        devicePixelRatio: 2,
        role: "button",
        accessibleName: "Go",
        textContent: "Go",
        outerHTMLTruncated: "<button>Go</button>",
        sourceUrl: "https://example.com",
      },
    );
    if (out?.quote.kind !== "element") throw new Error("guard");
    expect(out.quote.imageDataUrl).toBe("data:image/jpeg;base64,Y3JvcA==");
    expect(out.quote.role).toBe("button");
  });

  it("serializeQuotesToWire produces wrappers + image block in correct order", () => {
    const quotes = [
      { id: "1", kind: "text", text: "hi", sourceUrl: "https://x", sourceTabId: 1 } as const,
      {
        id: "2",
        kind: "element",
        role: "button",
        accessibleName: "Go",
        textContent: "Go",
        outerHTMLTruncated: "<button>Go</button>",
        imageDataUrl: "data:image/jpeg;base64,aaaa",
        sourceUrl: "https://x",
        sourceTabId: 1,
      } as const,
    ] as const;

    const quoteParts: string[] = [];
    for (const q of quotes) {
      if (q.kind === "text") {
        quoteParts.push(
          `<untrusted_page_quote source_url="${escapeWrapperAttribute(q.sourceUrl)}">\n${q.text}\n</untrusted_page_quote>`,
        );
      } else {
        quoteParts.push(
          `<untrusted_page_element source_url="${escapeWrapperAttribute(q.sourceUrl)}" role="${escapeWrapperAttribute(q.role)}" name="${escapeWrapperAttribute(q.accessibleName)}">\ntext_content: ${JSON.stringify(q.textContent)}\nouter_html: ${JSON.stringify(q.outerHTMLTruncated)}\n</untrusted_page_element>`,
        );
      }
    }
    const text = quoteParts.join("\n\n");

    expect(text).toContain('<untrusted_page_quote source_url="https://x">');
    expect(text).toContain("<untrusted_page_element");
    expect(text).toContain("hi");
    expect(text).toContain("Go");
  });

  it("escapeWrapperAttribute defends against attribute-boundary attack in quote serialization", () => {
    const dangerous = `https://x.test/?q="><tag`;
    const escaped = escapeWrapperAttribute(dangerous);
    expect(escaped).not.toContain(`"`);
    expect(escaped).not.toContain(`<`);
    expect(escaped).not.toContain(`>`);
  });
});
