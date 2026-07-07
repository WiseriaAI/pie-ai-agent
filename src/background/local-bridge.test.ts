import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROTOCOL_VERSION } from "@/types/local-bridge";

// 一个可编程的假 native port
function makeFakePort() {
  const listeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    postMessage: vi.fn(),
    onMessage: { addListener: (cb: (m: unknown) => void) => listeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => disconnectListeners.push(cb) },
    disconnect: vi.fn(),
    _emit: (m: unknown) => listeners.forEach((cb) => cb(m)),
    _disconnect: () => disconnectListeners.forEach((cb) => cb()),
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

  it("connectNative called with the daemon host name", async () => {
    const { initLocalBridge } = await import("./local-bridge");
    initLocalBridge();
    expect((globalThis as any).chrome.runtime.connectNative).toHaveBeenCalledWith("ai.wiseria.pie");
  });

  it("connectNative throwing degrades silently: not ready, no exception escapes", async () => {
    (globalThis as any).chrome = {
      runtime: {
        connectNative: vi.fn(() => {
          throw new Error("daemon not installed / no nativeMessaging permission");
        }),
      },
    };
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    expect(() => initLocalBridge()).not.toThrow();
    expect(isBridgeReady()).toBe(false);
  });

  it("onDisconnect resets ready/port and rejects pending requests", async () => {
    const { initLocalBridge, isBridgeReady, requestLocalAgent } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({ id: helloReq.id, ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent"] } });
    await Promise.resolve();
    expect(isBridgeReady()).toBe(true);

    const p = requestLocalAgent({ target: "claude", prompt: "hi" });
    // 让 requestLocalAgent 的 postMessage 先跑一次 microtask，保证 pending 里已经登记了它
    await Promise.resolve();

    fakePort._disconnect();

    expect(isBridgeReady()).toBe(false);
    await expect(p).rejects.toThrow("bridge disconnected");
  });

  it("protocolVersion diff > 1 stays not ready", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION + 5, capabilities: ["run_local_agent"] },
    });
    await Promise.resolve();
    expect(isBridgeReady()).toBe(false);
  });

  it("protocolVersion diff === 1 (compat window boundary) is ready", async () => {
    const { initLocalBridge, isBridgeReady } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION + 1, capabilities: ["run_local_agent"] },
    });
    await Promise.resolve();
    expect(isBridgeReady()).toBe(true);
  });

  it("requestHandoff resolves on matching id with the handoff dir", async () => {
    const { initLocalBridge, requestHandoff } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent"] },
    });

    const p = requestHandoff({ target: "claude", context: "do the thing" });
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    expect(req.method).toBe("handoff_to_agent");
    fakePort._emit({ id: req.id, ok: true, result: { dir: "/Users/x/pie-handoffs/2026-07-06-do-the-thing" } });
    await expect(p).resolves.toMatchObject({ dir: "/Users/x/pie-handoffs/2026-07-06-do-the-thing" });
  });

  it("requestListAgents sends list_agents when daemon advertises the capability", async () => {
    const { initLocalBridge, requestListAgents } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent", "list_agents"] },
    });
    await Promise.resolve();

    const p = requestListAgents();
    const req = fakePort.postMessage.mock.calls[1][0] as { id: string; method: string };
    expect(req.method).toBe("list_agents");
    fakePort._emit({
      id: req.id, ok: true,
      result: { agents: [{ id: "claude-app", label: "Claude Code (App)", installed: true }] },
    });
    await expect(p).resolves.toEqual([{ id: "claude-app", label: "Claude Code (App)", installed: true }]);
  });

  it("requestListAgents degrades to single legacy claude entry when capability missing (old daemon)", async () => {
    const { initLocalBridge, requestListAgents } = await import("./local-bridge");
    initLocalBridge();
    const helloReq = fakePort.postMessage.mock.calls[0][0] as { id: string };
    fakePort._emit({
      id: helloReq.id, ok: true,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: ["run_local_agent", "handoff_to_agent"] },
    });
    await Promise.resolve();

    await expect(requestListAgents()).resolves.toEqual([{ id: "claude", label: "Claude Code (Terminal)", installed: true }]);
    expect(fakePort.postMessage.mock.calls).toHaveLength(1); // 没有第二个 wire 请求
  });
});
