import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachSelectionListener, detachSelectionListener } from "./selection-listener";

const sendMessageMock = vi.fn();

beforeEach(() => {
  sendMessageMock.mockReset();
  document.body.innerHTML = "<p id='p'>Hello world</p>";
  // @ts-expect-error mock
  globalThis.chrome = { runtime: { sendMessage: sendMessageMock } };
  // @ts-expect-error
  globalThis.location = { href: "https://example.com/page" };
});

afterEach(() => {
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
  it("non-empty selection on mouseup → shows bubble", () => {
    attachSelectionListener();
    selectRange(0, 5);
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).not.toBeNull();
  });

  it("empty selection → no bubble", () => {
    attachSelectionListener();
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).toBeNull();
  });

  it("click bubble → sendMessage with selected text", async () => {
    attachSelectionListener();
    selectRange(0, 5);
    window.dispatchEvent(new MouseEvent("mouseup"));
    const host = document.documentElement.querySelector("[data-pie-quote-bubble]");
    const btn = host!.shadowRoot!.querySelector("button") as HTMLButtonElement;
    btn.click();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "quote-text-captured",
      payload: { text: "Hello", sourceUrl: "https://example.com/page" },
    });
  });

  it("selection cleared via selectionchange → bubble hides", async () => {
    attachSelectionListener();
    selectRange(0, 5);
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).not.toBeNull();
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).toBeNull();
  });

  it("detach removes listeners (no bubble after detach)", () => {
    attachSelectionListener();
    detachSelectionListener();
    selectRange(0, 5);
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(document.documentElement.querySelector("[data-pie-quote-bubble]")).toBeNull();
  });
});
