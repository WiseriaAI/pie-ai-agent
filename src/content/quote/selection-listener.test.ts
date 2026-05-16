import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachSelectionListener, detachSelectionListener } from "./selection-listener";
import { hideBubble } from "./floating-bubble";

const sendMessageMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  sendMessageMock.mockReset();
  document.body.innerHTML = "<p id='p'>Hello world</p>";
  // @ts-expect-error mock
  globalThis.chrome = { runtime: { sendMessage: sendMessageMock } };
  // @ts-expect-error
  globalThis.location = { href: "https://example.com/page" };
});

afterEach(() => {
  vi.useRealTimers();
  detachSelectionListener();
  window.getSelection()?.removeAllRanges();
});

function selectRange(start: number, end: number) {
  const p = document.getElementById("p")!;
  const range = document.createRange();
  range.setStart(p.firstChild!, start);
  range.setEnd(p.firstChild!, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  vi.spyOn(range, "getBoundingClientRect").mockReturnValue({
    top: 100, left: 50, right: 150, bottom: 120, x: 50, y: 100, width: 100, height: 20,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("selection listener", () => {
  it("non-empty selection on mouseup → shows bubble after setTimeout", () => {
    attachSelectionListener();
    selectRange(0, 5);
    // selectionchange fires during selectRange so bubble is already visible;
    // clear it first (resets module state), then test mouseup path
    hideBubble();
    window.dispatchEvent(new MouseEvent("mouseup"));
    // bubble not shown yet (setTimeout not run)
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).toBeNull();
    vi.runAllTimers();
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).not.toBeNull();
  });

  it("empty selection → no bubble (even after timers)", () => {
    attachSelectionListener();
    window.dispatchEvent(new MouseEvent("mouseup"));
    vi.runAllTimers();
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).toBeNull();
  });

  it("click bubble → sendMessage with selected text", async () => {
    attachSelectionListener();
    selectRange(0, 5);
    // selectionchange already triggered by selectRange → bubble should be visible
    const host = document.documentElement.querySelector("[data-pie-quote-bubble]");
    const btn = host!.shadowRoot!.querySelector("button") as HTMLButtonElement;
    btn.click();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "quote-text-captured",
      payload: { text: "Hello", sourceUrl: "https://example.com/page" },
    });
  });

  it("selection cleared via selectionchange → bubble hides", () => {
    attachSelectionListener();
    selectRange(0, 5);
    // selectionchange fires during selectRange → bubble visible
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).not.toBeNull();
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).toBeNull();
  });

  it("detach removes listeners (no bubble after detach)", () => {
    attachSelectionListener();
    detachSelectionListener();
    selectRange(0, 5);
    // selectionchange fires during selectRange but listeners are detached
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).toBeNull();
  });

  it("attach twice (same instance) does not duplicate handler — sendMessage fires once", () => {
    attachSelectionListener();
    attachSelectionListener();
    selectRange(0, 5);
    const host = document.documentElement.querySelector("[data-pie-quote-bubble]");
    const btn = host!.shadowRoot!.querySelector("button") as HTMLButtonElement;
    btn.click();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("cross-instance attach cleans up stale window handlers (simulates SW reinject)", () => {
    // Simulate the prior content-script instance: stale handlers parked on window.
    const staleMouseUp = vi.fn();
    const staleSelectionChange = vi.fn();
    window.addEventListener("mouseup", staleMouseUp);
    document.addEventListener("selectionchange", staleSelectionChange);
    (window as unknown as { __pieQuoteHandlers?: { mouseup: EventListener; selectionchange: EventListener } })
      .__pieQuoteHandlers = { mouseup: staleMouseUp, selectionchange: staleSelectionChange };

    // New instance: attach should remove the stale ones first.
    attachSelectionListener();
    window.dispatchEvent(new MouseEvent("mouseup"));
    document.dispatchEvent(new Event("selectionchange"));

    expect(staleMouseUp).not.toHaveBeenCalled();
    expect(staleSelectionChange).not.toHaveBeenCalled();
  });
});
