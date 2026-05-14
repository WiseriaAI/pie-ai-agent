import { describe, it, expect, beforeEach } from "vitest";
import { extractElementQuotePayload } from "./bbox-extractor";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("extractElementQuotePayload", () => {
  it("returns role from explicit aria role attribute", () => {
    document.body.innerHTML = `<div role="button" id="t">Click me</div>`;
    const el = document.getElementById("t")!;
    const out = extractElementQuotePayload(el, "https://example.com");
    expect(out.role).toBe("button");
  });

  it("falls back to tagName lowercase when no role", () => {
    document.body.innerHTML = `<button id="t">Send</button>`;
    const el = document.getElementById("t")!;
    expect(extractElementQuotePayload(el, "https://x").role).toBe("button");
  });

  it("accessibleName via aria-label", () => {
    document.body.innerHTML = `<button id="t" aria-label="Close dialog">X</button>`;
    const el = document.getElementById("t")!;
    expect(extractElementQuotePayload(el, "https://x").accessibleName).toBe("Close dialog");
  });

  it("accessibleName via label[for]", () => {
    document.body.innerHTML = `<label for="t">Username</label><input id="t" />`;
    const el = document.getElementById("t")!;
    expect(extractElementQuotePayload(el, "https://x").accessibleName).toBe("Username");
  });

  it("accessibleName via textContent fallback", () => {
    document.body.innerHTML = `<button id="t">Create issue</button>`;
    const el = document.getElementById("t")!;
    expect(extractElementQuotePayload(el, "https://x").accessibleName).toBe("Create issue");
  });

  it("textContent truncated to 500 chars", () => {
    document.body.innerHTML = `<div id="t">${"a".repeat(700)}</div>`;
    const el = document.getElementById("t")!;
    expect(extractElementQuotePayload(el, "https://x").textContent.length).toBe(500);
  });

  it("outerHTML truncated to 1000 chars", () => {
    document.body.innerHTML = `<div id="t">${"a".repeat(2000)}</div>`;
    const el = document.getElementById("t")!;
    expect(extractElementQuotePayload(el, "https://x").outerHTMLTruncated.length).toBe(1000);
  });

  it("bbox uses getBoundingClientRect + devicePixelRatio", () => {
    document.body.innerHTML = `<div id="t">x</div>`;
    const el = document.getElementById("t")!;
    const r = el.getBoundingClientRect();
    const out = extractElementQuotePayload(el, "https://x");
    expect(out.bbox).toEqual({ x: r.x, y: r.y, width: r.width, height: r.height });
    expect(out.devicePixelRatio).toBe(window.devicePixelRatio);
  });

  it("propagates sourceUrl", () => {
    document.body.innerHTML = `<button id="t">x</button>`;
    const el = document.getElementById("t")!;
    expect(extractElementQuotePayload(el, "https://foo.test/page").sourceUrl).toBe("https://foo.test/page");
  });
});
