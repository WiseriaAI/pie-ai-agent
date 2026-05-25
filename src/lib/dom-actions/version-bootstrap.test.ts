import { describe, it, expect, vi } from "vitest";
import { versionBootstrapInjected } from "./version-bootstrap";

describe("versionBootstrapInjected", () => {
  it("首次注入初始化 window.__pieFrameVersion__ = 0 并装 observer", () => {
    delete (window as any).__pieFrameVersion__;
    delete (window as any).__pieFrameObserver__;
    versionBootstrapInjected();
    expect((window as any).__pieFrameVersion__).toBe(0);
    expect((window as any).__pieFrameObserver__).toBeDefined();
  });

  it("重复注入不重装 observer", () => {
    versionBootstrapInjected();
    const observer1 = (window as any).__pieFrameObserver__;
    versionBootstrapInjected();
    expect((window as any).__pieFrameObserver__).toBe(observer1);
  });

  it("DOM mutation 触发 version++（防抖后）", async () => {
    delete (window as any).__pieFrameVersion__;
    delete (window as any).__pieFrameObserver__;
    versionBootstrapInjected();
    expect((window as any).__pieFrameVersion__).toBe(0);
    document.body.appendChild(document.createElement("div"));
    // wait for debounce (150ms) + a margin
    await new Promise((r) => setTimeout(r, 200));
    expect((window as any).__pieFrameVersion__).toBeGreaterThan(0);
  });
});
