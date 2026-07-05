import { describe, it, expect, vi, beforeEach } from "vitest";

describe("maybeInitLocalBridge", () => {
  beforeEach(() => vi.resetModules());

  it("无 nativeMessaging 权限 → 不 init", async () => {
    (globalThis as any).chrome = {
      permissions: { contains: vi.fn(async () => false) },
      runtime: { connectNative: vi.fn() },
    };
    const { maybeInitLocalBridge } = await import("./local-bridge");
    await maybeInitLocalBridge();
    expect((globalThis as any).chrome.runtime.connectNative).not.toHaveBeenCalled();
  });

  it("有权限 → init（connectNative 被调）", async () => {
    const fakePort = { postMessage: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() }, disconnect: vi.fn() };
    (globalThis as any).chrome = {
      permissions: { contains: vi.fn(async () => true) },
      runtime: { connectNative: vi.fn(() => fakePort) },
    };
    const { maybeInitLocalBridge } = await import("./local-bridge");
    await maybeInitLocalBridge();
    expect((globalThis as any).chrome.runtime.connectNative).toHaveBeenCalledWith("ai.wiseria.pie");
  });
});
