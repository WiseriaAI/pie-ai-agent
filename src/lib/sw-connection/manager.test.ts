import { describe, it, expect, vi, beforeEach } from "vitest";
import { swPort, __resetSwPort } from "./manager";

// test/setup.ts 的 chrome.runtime.connect mock 返回带 __ports 登记的 FakePort。
// 这里直接驱动它：每次 connect 产出一个新的 FakePort，可单独 fire / 触发 onDisconnect。
function lastPort() {
  const ports = (chrome.runtime as unknown as { __ports: FakePortLike[] }).__ports;
  return ports[ports.length - 1];
}
interface FakePortLike {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  fire: (m: unknown) => void;
  triggerDisconnect: () => void;
  disconnect: ReturnType<typeof vi.fn>;
}

beforeEach(() => __resetSwPort());

describe("swPort.connect", () => {
  it("opens a port named chat-stream-${id} and posts panel-mounted once", () => {
    swPort.connect("S1", {});
    expect(chrome.runtime.connect).toHaveBeenCalledWith({ name: "chat-stream-S1" });
    expect(lastPort().postMessage).toHaveBeenCalledWith({ type: "panel-mounted", sessionId: "S1" });
    // 二次 connect 同 session 不开第二个 port、不重发 panel-mounted
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockClear();
    swPort.connect("S1", {});
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
  });

  it("fans out inbound messages to all subscribers", () => {
    const a = vi.fn(); const b = vi.fn();
    swPort.connect("S1", { onMessage: a });
    swPort.connect("S1", { onMessage: b });
    lastPort().fire({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("re-wires the SAME subscribers onto a fresh port after disconnect (reconnect-safe)", () => {
    const a = vi.fn();
    swPort.connect("S1", { onMessage: a });
    lastPort().triggerDisconnect();          // SW idle-out
    swPort.send("S1", { type: "chat-abort" }); // lazy reconnect → new port
    lastPort().fire({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 });
    expect(a).toHaveBeenCalledTimes(1);       // 旧订阅者收到了新 port 的消息
  });

  it("calls onDisconnect handlers when the port dies, keeps subscribers", () => {
    const onDisc = vi.fn();
    swPort.connect("S1", { onDisconnect: onDisc });
    lastPort().triggerDisconnect();
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe removes only that handler", () => {
    const a = vi.fn();
    const unsub = swPort.connect("S1", { onMessage: a });
    unsub();
    lastPort().fire({ type: "chat-done", sessionId: "S1" } as never);
    expect(a).not.toHaveBeenCalled();
  });
});

describe("swPort.send", () => {
  it("reconnects and resends when the cached port throws (dead handle)", () => {
    swPort.connect("S1", {});
    const dead = lastPort();
    dead.postMessage.mockImplementationOnce(() => { throw new Error("disconnected port"); });
    const ok = swPort.send("S1", { type: "recording-start", sessionId: "S1" });
    expect(ok).toBe(true);
    // 新 port 收到了重发
    expect(lastPort().postMessage).toHaveBeenCalledWith({ type: "recording-start", sessionId: "S1" });
  });

  it("returns false when both attempts throw", () => {
    swPort.connect("S1", {});
    const ports = (chrome.runtime as unknown as { __ports: FakePortLike[] }).__ports;
    // 让后续所有 port 的 postMessage 都抛
    const orig = chrome.runtime.connect as ReturnType<typeof vi.fn>;
    orig.mockImplementation(() => {
      const p = makeThrowingPort();
      ports.push(p as never);
      return p as never;
    });
    expect(swPort.send("S2", { type: "chat-abort" })).toBe(false);
  });
});

describe("swPort.request", () => {
  it("passes the message through and returns the response", async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, id: "x" });
    const res = await swPort.request({ type: "schedule-action", action: "create" });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "schedule-action", action: "create" });
    expect(res).toEqual({ ok: true, id: "x" });
  });
  it("returns { ok:false } when sendMessage rejects", async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    expect(await swPort.request({})).toEqual({ ok: false, error: "boom" });
  });
});

function makeThrowingPort(): FakePortLike & { onMessage: { addListener: (l: unknown) => void }; onDisconnect: { addListener: (l: unknown) => void } } {
  return {
    name: "x",
    postMessage: vi.fn(() => { throw new Error("dead"); }),
    fire: () => {},
    triggerDisconnect: () => {},
    disconnect: vi.fn(),
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} },
  };
}
