import {
  PROTOCOL_VERSION,
  type BridgeRequest,
  type BridgeResponse,
  type RunLocalAgentParams,
  type RunLocalAgentResult,
  type HandoffParams,
  type HandoffResult,
  type ListAgentsResult,
} from "@/types/local-bridge";

const HOST_NAME = "ai.wiseria.pie";

let port: chrome.runtime.Port | null = null;
let ready = false;
let capabilities: string[] = [];
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function isBridgeReady(): boolean {
  return ready;
}
export function bridgeCapabilities(): string[] {
  return capabilities;
}

function send(method: BridgeRequest["method"], params: unknown): Promise<unknown> {
  if (!port) return Promise.reject(new Error("bridge not connected"));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port!.postMessage({ id, method, params });
  });
}

export function initLocalBridge(): void {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    // 未装 daemon / 无 nativeMessaging 权限 → 静默降级；清掉任何残留状态，
    // 避免失败的重新 init 留下上一次连接的 stale ready/capabilities/pending。
    port = null;
    ready = false;
    capabilities = [];
    pending.clear();
    return;
  }
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as BridgeResponse;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error.message));
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime?.lastError; // 读一下避免 Chrome 打印 "Unchecked runtime.lastError"
    ready = false;
    port = null;
    capabilities = [];
    for (const p of pending.values()) p.reject(new Error("bridge disconnected"));
    pending.clear();
    // ponytail: Slice 0 不做指数退避重连；spec §8 的重连留后续 slice
  });
  // 握手
  send("hello", { protocolVersion: PROTOCOL_VERSION })
    .then((r) => {
      const res = r as { protocolVersion: number; capabilities: string[] };
      // 兼容窗口：差 ≤1 视为兼容（spec §7）
      if (Math.abs(res.protocolVersion - PROTOCOL_VERSION) <= 1) {
        capabilities = res.capabilities;
        ready = true;
      }
    })
    .catch(() => { ready = false; });
}

export async function requestLocalAgent(params: RunLocalAgentParams): Promise<RunLocalAgentResult> {
  const r = await send("run_local_agent", params);
  return r as RunLocalAgentResult;
}

export async function requestHandoff(params: HandoffParams): Promise<HandoffResult> {
  const r = await send("handoff_to_agent", params);
  return r as HandoffResult;
}

export async function requestListAgents(): Promise<{ id: string; label: string; installed: boolean }[]> {
  // 旧 daemon（无 list_agents capability）降级为单项 legacy 列表：id "claude"
  // 是旧 wire 值，installed 视为 true（维持旧 daemon 可 handoff 的语义）。
  if (!capabilities.includes("list_agents")) {
    return [{ id: "claude", label: "Claude Code (Terminal)", installed: true }];
  }
  const r = (await send("list_agents", {})) as ListAgentsResult;
  return r.agents;
}

/** SW 启动调用：仅当已授予 nativeMessaging 才连桥（纯 BYOK 用户零感知）。 */
export async function maybeInitLocalBridge(): Promise<void> {
  try {
    const has = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
    if (has) initLocalBridge();
  } catch {
    // permissions API 不可用（测试/老 Chrome）→ 静默跳过
  }
}

/** 用户在设置里关掉本地打通（移除 nativeMessaging）时断桥并清状态。 */
export function disconnectLocalBridge(): void {
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* already dead */
    }
  }
  port = null;
  ready = false;
  capabilities = [];
  for (const p of pending.values()) p.reject(new Error("bridge disabled"));
  pending.clear();
}
