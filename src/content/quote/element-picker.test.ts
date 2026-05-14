import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enterPicker, exitPicker, __test__isPicking } from "./element-picker";

const sendMessageMock = vi.fn();

beforeEach(() => {
  sendMessageMock.mockReset();
  document.body.innerHTML = `<button id="b">Create issue</button><div id="d">x</div>`;
  // @ts-expect-error mock
  globalThis.chrome = { runtime: { sendMessage: sendMessageMock } };
  // @ts-expect-error
  globalThis.location = { href: "https://example.com" };
});

afterEach(() => {
  exitPicker();
  document.documentElement.querySelectorAll("[data-pie-quote-picker]").forEach((el) => el.remove());
});

describe("element picker", () => {
  it("enter → picking=true; overlay host appears", () => {
    enterPicker();
    expect(__test__isPicking()).toBe(true);
    expect(document.documentElement.querySelector("[data-pie-quote-picker]")).not.toBeNull();
  });

  it("exit → picking=false; overlay host removed", () => {
    enterPicker();
    exitPicker();
    expect(__test__isPicking()).toBe(false);
    expect(document.documentElement.querySelector("[data-pie-quote-picker]")).toBeNull();
  });

  it("click on element → sendMessage quote-element-captured then exit", () => {
    enterPicker();
    const b = document.getElementById("b")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    // Mock elementFromPoint to return the button
    const orig = document.elementFromPoint.bind(document);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(b);
    b.dispatchEvent(evt);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const call = sendMessageMock.mock.calls[0][0];
    expect(call.type).toBe("quote-element-captured");
    expect(call.payload.role).toBe("button");
    expect(call.payload.accessibleName).toBe("Create issue");
    expect(__test__isPicking()).toBe(false);
    vi.spyOn(document, "elementFromPoint").mockRestore?.();
  });

  it("Esc → exit", () => {
    enterPicker();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(__test__isPicking()).toBe(false);
  });

  it("right-click (contextmenu) → exit", () => {
    enterPicker();
    document.dispatchEvent(new MouseEvent("contextmenu"));
    expect(__test__isPicking()).toBe(false);
  });

  it("click is consumed (preventDefault) so site handlers do NOT fire", () => {
    let siteHandlerFired = false;
    document.getElementById("b")!.addEventListener("click", () => {
      siteHandlerFired = true;
    });
    enterPicker();
    const b = document.getElementById("b")!;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(b);
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(siteHandlerFired).toBe(false);
  });
});
