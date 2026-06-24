import type { PortMessageToPanel, PortMessageToWorker } from "@/types";

type OnMessage = (msg: PortMessageToPanel) => void;
type OnDisconnect = () => void;

// 订阅生命周期与 port 生命周期分离：subs 跨重连存活，ports 随 SW 死/重连增删。
const subs = new Map<string, { onMessage: Set<OnMessage>; onDisconnect: Set<OnDisconnect> }>();
const ports = new Map<string, chrome.runtime.Port>();

function handlersFor(sessionId: string) {
  let h = subs.get(sessionId);
  if (!h) {
    h = { onMessage: new Set(), onDisconnect: new Set() };
    subs.set(sessionId, h);
  }
  return h;
}

function openPort(sessionId: string): chrome.runtime.Port {
  const port = chrome.runtime.connect({ name: `chat-stream-${sessionId}` });
  // 唯一一个 onMessage listener，fan-out 给当前订阅者（每次读最新集合 → 重连安全）。
  port.onMessage.addListener((msg) => {
    const h = subs.get(sessionId);
    if (!h) return;
    for (const fn of h.onMessage) fn(msg as PortMessageToPanel);
  });
  port.onDisconnect.addListener(() => {
    // 身份比对：sibling 重连可能已写入新 port，别误删。
    if (ports.get(sessionId) === port) ports.delete(sessionId);
    const h = subs.get(sessionId);
    if (h) for (const fn of h.onDisconnect) fn();
  });
  ports.set(sessionId, port);
  // panel-mounted 握手：SW 据此从 storage 重建 session 状态。极端竞态下新 port 可能
  // 立刻死 → 吞掉，下次 send 的 tryOnce 会再失败并走重连。
  try {
    port.postMessage({ type: "panel-mounted", sessionId } satisfies PortMessageToWorker);
  } catch (e) {
    console.warn(`[swPort] panel-mounted failed for session=${sessionId}:`, e);
  }
  return port;
}

function ensurePort(sessionId: string): chrome.runtime.Port {
  return ports.get(sessionId) ?? openPort(sessionId);
}

export const swPort = {
  connect(
    sessionId: string,
    handlers: { onMessage?: OnMessage; onDisconnect?: OnDisconnect },
  ): () => void {
    const h = handlersFor(sessionId);
    if (handlers.onMessage) h.onMessage.add(handlers.onMessage);
    if (handlers.onDisconnect) h.onDisconnect.add(handlers.onDisconnect);
    ensurePort(sessionId);
    return () => {
      const hh = subs.get(sessionId);
      if (!hh) return;
      if (handlers.onMessage) hh.onMessage.delete(handlers.onMessage);
      if (handlers.onDisconnect) hh.onDisconnect.delete(handlers.onDisconnect);
    };
  },

  // 透明重连重发：在现有/新建 port 上 postMessage；抛错则丢死 port、重连、重发一次。
  send(sessionId: string, payload: PortMessageToWorker): boolean {
    const tryOnce = (p: chrome.runtime.Port): boolean => {
      try {
        p.postMessage(payload);
        return true;
      } catch {
        return false;
      }
    };
    let port = ensurePort(sessionId);
    if (tryOnce(port)) return true;
    if (ports.get(sessionId) === port) {
      ports.delete(sessionId);
      try { port.disconnect(); } catch { /* already dead */ }
    }
    port = ensurePort(sessionId);
    return tryOnce(port);
  },

  // 强制丢旧建新（quote-needs-reconnect：SW 因零活 port 把 quote 暂存了）。
  reconnect(sessionId: string): void {
    const stale = ports.get(sessionId);
    if (stale) {
      try { stale.disconnect(); } catch { /* noop */ }
      ports.delete(sessionId);
    }
    ensurePort(sessionId);
  },

  disconnect(sessionId: string): void {
    const port = ports.get(sessionId);
    if (!port) return;
    try { port.disconnect(); } catch { /* noop */ }
    ports.delete(sessionId);
  },

  // panel unmount：断开所有 port，并清订阅表（兜底 + 与 __resetSwPort 对称）。
  // 各订阅方的 React effect cleanup 也会各自 unsubscribe，这里是 panel 整体卸载的终态清理。
  disconnectAll(): void {
    for (const port of ports.values()) {
      try { port.disconnect(); } catch { /* noop */ }
    }
    ports.clear();
    subs.clear();
  },

  // RPC 通道：薄包 runtime.sendMessage（MV3 自动唤醒 SW，无需重连）。
  async request<TRes = unknown>(
    message: unknown,
  ): Promise<TRes | { ok: false; error: string }> {
    try {
      const res = (await chrome.runtime.sendMessage(message)) as TRes | undefined;
      // 契约：本通道服务请求/响应型 RPC（如 schedules CRUD，SW handler 必返
      // {ok,...}）。无响应（SW 未应答）视为失败。fire-and-forget 型消息请直接
      // 用 runtime.sendMessage，别走 request。
      if (res === undefined || res === null) {
        return { ok: false, error: "no response from background worker" };
      }
      return res;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export function __resetSwPort(): void {
  for (const port of ports.values()) {
    try { port.disconnect(); } catch { /* noop */ }
  }
  ports.clear();
  subs.clear();
}
