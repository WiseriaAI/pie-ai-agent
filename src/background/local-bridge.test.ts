import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROTOCOL_VERSION } from "@/types/local-bridge";

// 一个可编程的假 native port
function makeFakePort() {
  const listeners: Array<(m: unknown) => void> = [];
  return {
    postMessage: vi.fn(),
    onMessage: { addListener: (cb: (m: unknown) => void) => listeners.push(cb) },
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
    _emit: (m: unknown) => listeners.forEach((cb) => cb(m)),
  };
}

describe("local-bridge", () => {
  let fakePort: ReturnType<typeof makeFakePort>;
  beforeEach(() => {
    vi.resetModules();
    fakePort = makeFakePort();
    (globalThis as any).chrome = {
      runtime: { connectNative: vi.fn(() => fakePort) },
    };
  });

  it("not ready before hello reply", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    expect(isBridgeReady()).toBe(false);
  });

  it("ready after hello reply with matching protocolVersion", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    // 抓 hello 请求，回 hello 响应
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent"] },
    });
    // hello 走 send() 返回的真实 Promise：resolve() 同步触发，但 .then() 里的
    // ready=true 要等下一个 microtask 才跑；flush 一次 microtask 队列再断言。
    await Promise.resolve();
    expect(isBridgeReady()).toBe(true);
  });

  it("requestLocalAgent resolves on matching id", async () => {
    const { initLocalBridge, requestLocalAgent } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({ id: helloReq.id, ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: [] } });

    const p = requestLocalAgent({ target: "claude", prompt: "hi" });
    const runReq = fakePort.postMessage.mock.calls[1][0] as { id: string };
    fakePort._emit({ id: runReq.id, ok: true, result: { output: "REPLY", exitCode: 0, cwd: "/tmp/x" } });
    await expect(p).resolves.toMatchObject({ output: "REPLY" });
  });
});
