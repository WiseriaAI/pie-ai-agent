import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachSubscribeBridge, detachSubscribeBridge } from "./subscribe-bridge";

const sendMessageMock = vi.fn();

function setup(hostname: string) {
  // @ts-expect-error minimal chrome mock
  globalThis.chrome = { runtime: { sendMessage: sendMessageMock } };
  // @ts-expect-error minimal location mock
  globalThis.location = { hostname };
  document.body.innerHTML = `
    <a id="sub" href="https://store" data-pie-subscribe><span id="inner">Subscribe</span></a>
    <a id="plain" href="https://store">Install</a>`;
}

function click(id: string): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(ev);
  return ev;
}

beforeEach(() => sendMessageMock.mockReset());
afterEach(() => {
  detachSubscribeBridge();
  document.body.innerHTML = "";
});

describe("subscribe bridge", () => {
  it("on pie.chat: click on a marked CTA sends open-managed-subscribe + prevents default", () => {
    setup("www.pie.chat");
    attachSubscribeBridge();
    const ev = click("sub");
    expect(sendMessageMock).toHaveBeenCalledWith({ type: "open-managed-subscribe" });
    expect(ev.defaultPrevented).toBe(true);
  });

  it("matches clicks on descendants of the marked CTA (closest)", () => {
    setup("www.pie.chat");
    attachSubscribeBridge();
    click("inner");
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it("ignores clicks on unmarked elements", () => {
    setup("www.pie.chat");
    attachSubscribeBridge();
    const ev = click("plain");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("is a no-op off the allowlist (a random site can't open the panel)", () => {
    setup("evil.example.com");
    attachSubscribeBridge();
    const ev = click("sub");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
