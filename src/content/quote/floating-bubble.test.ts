import { describe, it, expect, vi, beforeEach } from "vitest";
import { showBubble, hideBubble, __test__isVisible } from "./floating-bubble";

beforeEach(() => {
  document.body.innerHTML = "";
  hideBubble();
  document.documentElement.querySelectorAll("[data-pie-quote-bubble]").forEach((el) => el.remove());
  Object.defineProperty(window, "innerHeight", { value: 1000, writable: true });
  Object.defineProperty(window, "innerWidth", { value: 1280, writable: true });
});

describe("floating bubble", () => {
  it("renders a host element in Shadow DOM", () => {
    showBubble({ anchorTop: 100, anchorLeft: 200, onClick: vi.fn() });
    const host = document.documentElement.querySelector("[data-pie-quote-bubble]");
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();
  });

  it("places bubble ABOVE selection when room above", () => {
    showBubble({ anchorTop: 500, anchorLeft: 200, onClick: vi.fn() });
    const host = document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]")!;
    const styleTop = parseInt(host.style.top, 10);
    expect(styleTop).toBeLessThan(500);
  });

  it("falls back BELOW when no room above", () => {
    showBubble({ anchorTop: 5, anchorLeft: 200, onClick: vi.fn() });
    const host = document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]")!;
    const styleTop = parseInt(host.style.top, 10);
    expect(styleTop).toBeGreaterThan(5);
  });

  it("idempotent: show twice → still one host", () => {
    showBubble({ anchorTop: 100, anchorLeft: 200, onClick: vi.fn() });
    showBubble({ anchorTop: 110, anchorLeft: 210, onClick: vi.fn() });
    expect(document.documentElement.querySelectorAll("[data-pie-quote-bubble]").length).toBe(1);
  });

  it("hide removes the host", () => {
    showBubble({ anchorTop: 100, anchorLeft: 200, onClick: vi.fn() });
    hideBubble();
    expect(__test__isVisible()).toBe(false);
  });

  it("clamps left when selection touches viewport right edge", () => {
    showBubble({ anchorTop: 100, anchorLeft: 1278, onClick: vi.fn() });
    const host = document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]")!;
    const styleLeft = parseInt(host.style.left, 10);
    expect(styleLeft).toBeLessThanOrEqual(1280 - 24 - 6);
    expect(styleLeft).toBeGreaterThanOrEqual(1280 - 24 - 6);
  });

  it("clamps left when selection touches viewport left edge", () => {
    showBubble({ anchorTop: 100, anchorLeft: -50, onClick: vi.fn() });
    const host = document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]")!;
    const styleLeft = parseInt(host.style.left, 10);
    expect(styleLeft).toBe(6);
  });

  it("respects anchorLeft when within viewport bounds", () => {
    showBubble({ anchorTop: 100, anchorLeft: 600, onClick: vi.fn() });
    const host = document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]")!;
    const styleLeft = parseInt(host.style.left, 10);
    expect(styleLeft).toBe(600);
  });

  it("click in shadow root invokes callback then hides", () => {
    const onClick = vi.fn();
    showBubble({ anchorTop: 100, anchorLeft: 200, onClick });
    const host = document.documentElement.querySelector<HTMLElement>("[data-pie-quote-bubble]")!;
    const btn = host.shadowRoot!.querySelector<HTMLButtonElement>("button")!;
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(__test__isVisible()).toBe(false);
  });
});
