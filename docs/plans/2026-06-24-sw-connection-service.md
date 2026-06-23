# SW 连接服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 panel↔SW 的 per-session port 通道收编进一个单例连接服务（透明重连 + 重连安全订阅），三个 port 消费方全迁移，修掉录制偶发无反应的 bug。

**Architecture:** 新增模块级单例 `swPort`（`src/lib/sw-connection/manager.ts`）。port 通道暴露 `connect/send/reconnect/disconnect/disconnectAll`；订阅方只交回调、永不持有 port handle，服务在重连时把同批订阅者重挂到新 port，结构性消除 stale-handle。RPC 通道（schedules）走薄 `request`（包 `runtime.sendMessage`，不加重连）。

**Tech Stack:** TypeScript 6 · React 19 · Chrome MV3（`chrome.runtime.connect` port + `chrome.runtime.sendMessage` RPC）· vitest + @testing-library/react + happy-dom。

## Global Constraints

- 设计权威源：`docs/specs/2026-06-24-sw-connection-service-design.md`。
- 管理器放 `src/lib/sw-connection/`（lib 层，供 sidepanel 与 lib/schedules 共用；禁止 lib→sidepanel 反向依赖）。
- port name 维持 `chat-stream-${sessionId}`（SW 端按此 parse sessionId，不可改）。
- `useSession()` 签名不可加必填参数（~46 处测试调用）；服务用单例 + `__resetSwPort()` 隔离。
- 迁移 useSession 为**行为保持不变**的机械迁移；底层仍调 `chrome.runtime.connect`，使现有 mock 与 useSession 测试继续作回归网。
- 每个 task 结束前跑相关测试；全部 task 完成后跑 `pnpm test` + `pnpm typecheck` + `pnpm build` 三绿。
- 提交信息结尾两行：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01HdoWkLDFTZmfUrqzFiTyJs`。

## File Structure

- Create `src/lib/sw-connection/manager.ts` — 单例 `swPort`（port 通道 + RPC `request`）+ `__resetSwPort`。唯一拥有 port handle 的地方。
- Create `src/lib/sw-connection/manager.test.ts` — 管理器单测。
- Modify `src/test/setup.ts` — `beforeEach` 调 `__resetSwPort()`。
- Modify `src/sidepanel/hooks/useSession/index.ts` — 删私有 port 机制，改用 `swPort`；删 `UseSession.port`。
- Modify `src/sidepanel/hooks/useRecording.ts` — 删 `port` prop，改用 `swPort`。
- Modify `src/sidepanel/hooks/useRecording.test.ts` — 重写为 mock `swPort`。
- Modify `src/sidepanel/App.tsx` — useRecording 不再收 `port`。
- Modify `src/lib/schedules/panel-actions.ts` — `send` 改调 `swPort.request`。

---

## Task 1: 连接服务管理器（单例 + 单测 + 测试隔离）

**Files:**
- Create: `src/lib/sw-connection/manager.ts`
- Test: `src/lib/sw-connection/manager.test.ts`
- Modify: `src/test/setup.ts:337-344`（beforeEach 区段）

**Interfaces:**
- Consumes: `PortMessageToPanel` / `PortMessageToWorker`（`@/types`）；`chrome.runtime.connect` / `chrome.runtime.sendMessage`。
- Produces:
  - `swPort.connect(sessionId: string, handlers: { onMessage?: (msg: PortMessageToPanel) => void; onDisconnect?: () => void }): () => void`
  - `swPort.send(sessionId: string, payload: PortMessageToWorker): boolean`
  - `swPort.reconnect(sessionId: string): void`
  - `swPort.disconnect(sessionId: string): void`
  - `swPort.disconnectAll(): void`
  - `swPort.request<TRes = unknown>(message: unknown): Promise<TRes | { ok: false; error: string }>`
  - `__resetSwPort(): void`

- [ ] **Step 1: 写失败测试**（先放最关键的几条；fan-out / 重连安全 / send 重试）

```ts
// src/lib/sw-connection/manager.test.ts
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

function makeThrowingPort(): FakePortLike {
  return {
    name: "x",
    postMessage: vi.fn(() => { throw new Error("dead"); }),
    fire: () => {},
    triggerDisconnect: () => {},
    disconnect: vi.fn(),
  };
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/sw-connection/manager.test.ts`
Expected: FAIL（`manager.ts` 不存在 / 导出缺失）。

注：若 `test/setup.ts` 的 FakePort 未提供 `fire` / `triggerDisconnect` / 多 port 登记 `__ports`，先在 Step 3a 补齐 mock，再让测试可运行。

- [ ] **Step 3a: 确认/补齐 test/setup.ts 的 FakePort 能力**

打开 `src/test/setup.ts`，确认 `chrome.runtime.connect` mock：每次调用产出新的 FakePort 并 push 进 `runtime.__ports`，且 FakePort 暴露 `fire(msg)`（触发已注册 onMessage listeners）、`triggerDisconnect()`（触发已注册 onDisconnect listeners）、`postMessage`（vi.fn）、`disconnect`（vi.fn）。若已具备则跳过；若 `connect` 返回单例/不登记多 port，改成每次 new 一个并 push。**保持现有字段名不变**，只增强为多 port。

- [ ] **Step 3b: 写实现 `manager.ts`**

```ts
// src/lib/sw-connection/manager.ts
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

  // panel unmount：断开所有 port。订阅者由各自 React effect cleanup 调 unsubscribe 清理。
  disconnectAll(): void {
    for (const port of ports.values()) {
      try { port.disconnect(); } catch { /* noop */ }
    }
    ports.clear();
  },

  // RPC 通道：薄包 runtime.sendMessage（MV3 自动唤醒 SW，无需重连）。
  async request<TRes = unknown>(
    message: unknown,
  ): Promise<TRes | { ok: false; error: string }> {
    try {
      const res = (await chrome.runtime.sendMessage(message)) as TRes | undefined;
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
```

- [ ] **Step 4: 在 test/setup.ts 的 beforeEach 加 reset**

在 `src/test/setup.ts` 的 `beforeEach`（约 337 行）里，`runtime.connect.mockClear()` 之后加：

```ts
  // SW 连接服务单例：每个测试隔离。
  __resetSwPort();
```

并在文件顶部 import：`import { __resetSwPort } from "@/lib/sw-connection/manager";`

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/sw-connection/manager.test.ts`
Expected: PASS（全部用例绿）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/sw-connection/manager.ts src/lib/sw-connection/manager.test.ts src/test/setup.ts
git commit -m "feat(sw-connection): 单例 swPort 连接服务（port 重连安全订阅 + RPC request）"
```

---

## Task 2: port 通道 cutover（useSession + useRecording + downloadOutput + App）

> 这是端口所有权从 useSession 私有 `portsRef` 转移到 `swPort` 的**原子步**——同一 session 只能有一个 port owner，所有 port 消费方必须一起迁。useSession 现有 ~46 处测试 + useRecording 重写测试是回归网。

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`
- Modify: `src/sidepanel/hooks/useRecording.ts`
- Modify: `src/sidepanel/hooks/useRecording.test.ts`
- Modify: `src/sidepanel/App.tsx:91-95`

**Interfaces:**
- Consumes: Task 1 的 `swPort.connect / send / reconnect / disconnectAll`。
- Produces: `useSession` 不再导出 `port`；`useRecording({ sessionId, onFinished })`（去掉 `port` prop）。

- [ ] **Step 1: useRecording 红测试——发送必须走 swPort.send（重写测试文件）**

把 `src/sidepanel/hooks/useRecording.test.ts` 整体重写为 mock `swPort`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { RecordedAction } from "@/lib/recording/types";

// 捕获 connect 注册的 onMessage，供测试 fire 广播。
let captured: ((m: unknown) => void) | null = null;
const send = vi.fn(() => true);
vi.mock("@/lib/sw-connection/manager", () => ({
  swPort: {
    connect: (_sid: string, h: { onMessage?: (m: unknown) => void }) => {
      captured = h.onMessage ?? null;
      return () => { captured = null; };
    },
    send,
  },
}));

import { useRecording } from "./useRecording";

beforeEach(() => {
  send.mockClear();
  captured = null;
});

describe("useRecording", () => {
  it("startRecording routes through swPort.send (survives a dead port)", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => result.current.startRecording());
    expect(send).toHaveBeenCalledWith("S1", { type: "recording-start", sessionId: "S1" });
  });

  it("recording-started broadcast flips active=true", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => captured?.({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 }));
    expect(result.current.active).toBe(true);
  });

  it("recording-action-broadcast appends action", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => captured?.({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 }));
    const action: RecordedAction = { type: "click", label: "X", url: "u", region: "main", timestamp: 1 };
    act(() => captured?.({ type: "recording-action-broadcast", sessionId: "S1", action }));
    expect(result.current.actions).toEqual([action]);
  });

  it("rejects messages from other sessionId", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => captured?.({ type: "recording-started", sessionId: "S2", tabId: 1, origin: "x", startedAt: 0 }));
    expect(result.current.active).toBe(false);
  });

  it("recording-finished surfaces serializedTrace + stepCount and resets", () => {
    const onFinished = vi.fn();
    const { result } = renderHook(() => useRecording({ sessionId: "S1", onFinished }));
    act(() => {
      captured?.({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 });
      captured?.({ type: "recording-finished", sessionId: "S1", serializedTrace: "第 1 步：点击按钮 'X'", stepCount: 1 });
    });
    expect(result.current.active).toBe(false);
    expect(result.current.actions).toEqual([]);
    expect(onFinished).toHaveBeenCalledWith("第 1 步：点击按钮 'X'", 1);
  });

  it("recording-aborted resets state and exposes reason", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => {
      captured?.({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 });
      captured?.({ type: "recording-aborted", sessionId: "S1", reason: "tab-closed" });
    });
    expect(result.current.active).toBe(false);
    expect(result.current.lastAbortReason).toBe("tab-closed");
  });

  it("session change while recording fires discard via swPort.send to the PREVIOUS session", () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useRecording({ sessionId }),
      { initialProps: { sessionId: "S1" } },
    );
    act(() => captured?.({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 }));
    send.mockClear();
    rerender({ sessionId: "S2" });
    expect(send).toHaveBeenCalledWith("S1", { type: "recording-discard", sessionId: "S1" });
    expect(result.current.active).toBe(false);
  });

  it("finishRecording posts simple recording-finish", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => result.current.finishRecording());
    expect(send).toHaveBeenCalledWith("S1", { type: "recording-finish", sessionId: "S1" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/hooks/useRecording.test.ts`
Expected: FAIL（旧 useRecording 收 `port` prop、用 `port.postMessage`，未调 `swPort.send`；且 mock 的 connect 未被使用）。

- [ ] **Step 3: 迁移 useRecording.ts**

改 `src/sidepanel/hooks/useRecording.ts`：

1. 顶部 import：`import { swPort } from "@/lib/sw-connection/manager";`，并 import 类型 `import type { PortMessageToWorker } from "@/types";`（如需要）。
2. `UseRecordingArgs` 去掉 `port`，保留 `sessionId` / `onFinished`。
3. 会话切换 auto-discard effect：把 `if (prev && sessionId !== prev && activeRef.current && port)` 内的 `port.postMessage({ type: "recording-discard", sessionId: prev })` 改为：

```ts
    if (prev && sessionId !== prev && activeRef.current) {
      swPort.send(prev, { type: "recording-discard", sessionId: prev });
      setActive(false);
      activeRef.current = false;
      setActions([]);
      setLastAbortReason("session-switched");
    }
```
（去掉 `&& port` 与 `try/catch`；effect deps 从 `[sessionId, port]` 改为 `[sessionId]`。）

4. listener effect 改为经 `swPort.connect` 订阅（去掉 `if (!port) return` 与 `port.onMessage.add/removeListener`）：

```ts
  useEffect(() => {
    if (!sessionId) return;
    const listener = (msg: PortMessageToPanel) => {
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      if (
        msg.type !== "recording-started" &&
        msg.type !== "recording-action-broadcast" &&
        msg.type !== "recording-finished" &&
        msg.type !== "recording-aborted"
      ) return;
      if (msg.sessionId !== sessionRef.current) return;
      // ...（其余分支体保持不变：started/action/finished/aborted）
    };
    const unsubscribe = swPort.connect(sessionId, { onMessage: listener });
    return unsubscribe;
  }, [sessionId, onFinished]);
```

5. 三个发送改 `swPort.send`，去掉 `if (!port)` 守卫（保留 `if (!sessionId) return`）：

```ts
  const startRecording = useCallback(() => {
    if (!sessionId) return;
    swPort.send(sessionId, { type: "recording-start", sessionId });
  }, [sessionId]);

  const finishRecording = useCallback(() => {
    if (!sessionId) return;
    swPort.send(sessionId, { type: "recording-finish", sessionId });
  }, [sessionId]);

  const discardRecording = useCallback(() => {
    if (!sessionId) return;
    swPort.send(sessionId, { type: "recording-discard", sessionId });
  }, [sessionId]);
```

- [ ] **Step 4: 跑 useRecording 测试确认通过**

Run: `pnpm test src/sidepanel/hooks/useRecording.test.ts`
Expected: PASS。

- [ ] **Step 5: 迁移 useSession/index.ts —— 删私有 port 机制，改用 swPort**

改 `src/sidepanel/hooks/useSession/index.ts`：

1. 顶部 import：`import { swPort } from "@/lib/sw-connection/manager";`
2. **删除**：`portsRef`（266 行）、`connectPortFor`（346-372）、`getOrReconnectPort`（377-386）、`postWithReconnect`（392-412）。`postWithReconnectRef`（276 行）保留声明，但 `.current` 改指 `swPort.send`：

```ts
  // port-handlers 的 chat-instruction-rejected 回退用；指向 swPort.send。
  const postWithReconnectRef = useRef<((id: string, payload: PortMessageToWorker) => boolean) | null>(
    (id, payload) => swPort.send(id, payload),
  );
```
（这样 createPortHandlers 的 `postMessageRef` 依赖不变。）

3. mount bootstrap（464 行）`portsRef.current.set(meta.id, connectPortFor(meta.id))` 改：

```ts
        swPort.connect(meta.id, {
          onMessage: portHandlers.handleMessage,
          onDisconnect: portHandlers.makeDisconnectHandler(meta.id),
        });
```

4. mount cleanup（470-479）整段 for-loop disconnect + `portsRef.current.clear()` 改：

```ts
    return () => {
      cancelled = true;
      swPort.disconnectAll();
    };
```
（effect deps `[connectPortFor]` 改为 `[]`——不再依赖已删的 connectPortFor；bootstrap 仅 mount 跑一次。）

5. quote-needs-reconnect effect（492-512）body 改：

```ts
      const id = sessionIdRef.current;
      if (!id) return;
      swPort.reconnect(id);
```
（deps `[connectPortFor]` 改 `[]`。）

6. 所有 `postWithReconnect(id, payload)` 调用点改 `swPort.send(id, payload)`：`sendMessage`（690）、`addPendingInstruction`（785）、`cancelPendingInstruction`（815）、`abort`（830）、`resumeTask`（843）。各自的 `if (!sent)` revert 分支保持不变。相应 useCallback 依赖数组里的 `postWithReconnect` 去掉。

7. setActive（957-963）改：

```ts
    if (
      !portsHas(id) &&
      metaForActivate.status !== "archived" &&
      metaForActivate.status !== "paused"
    ) {
      swPort.connect(id, {
        onMessage: portHandlers.handleMessage,
        onDisconnect: portHandlers.makeDisconnectHandler(id),
      });
    }
```
其中 `portsHas` 的语义（"是否已有该 session 的活 port"）现由 swPort 内部判断——`swPort.connect` 本身幂等（同 session 二次 connect 不开第二 port、不重发 panel-mounted），所以**直接无条件调 `swPort.connect`** 即可，去掉 `!portsHas(id)` 条件，仅保留 archived/paused 守卫：

```ts
    if (metaForActivate.status !== "archived" && metaForActivate.status !== "paused") {
      swPort.connect(id, {
        onMessage: portHandlers.handleMessage,
        onDisconnect: portHandlers.makeDisconnectHandler(id),
      });
    }
```
deps `[connectPortFor, patchSlot]` → `[patchSlot]`。

8. createAndActivate（988）`portsRef.current.set(meta.id, connectPortFor(meta.id))` 改：

```ts
    swPort.connect(meta.id, {
      onMessage: portHandlers.handleMessage,
      onDisconnect: portHandlers.makeDisconnectHandler(meta.id),
    });
```
deps `[connectPortFor, patchSlot]` → `[patchSlot]`。

9. downloadOutput（1052-1066）改用 `swPort.send`（去掉 `getOrReconnectPort` + raw postMessage + catch）：

```ts
  const downloadOutput = useCallback((artifactId: string): Promise<DownloadResult> => {
    const sid = sessionIdRef.current;
    if (!sid) return Promise.resolve({ status: "error" as const });
    return new Promise<DownloadResult>((resolve) => {
      registerDownload(artifactId, resolve);
      const ok = swPort.send(sid, { type: "download-output", artifactId });
      if (!ok) {
        resolveDownload(artifactId, { status: "error" });
        return;
      }
      window.setTimeout(() => resolveDownload(artifactId, { status: "error" }), 30_000);
    });
  }, []);
```

10. **删 `UseSession.port`**：去掉 interface 里的 `port` 字段（238-240）与返回对象里的 `port: sessionIdRef.current ? ... : null`（1070）。

- [ ] **Step 6: 迁移 App.tsx —— useRecording 不再传 port**

`src/sidepanel/App.tsx:91-95`：

```tsx
  const recording = useRecording({
    sessionId: session.sessionId,
    onFinished: handleRecordingFinished,
  });
```
（删 `port: session.port,` 一行。）

- [ ] **Step 7: 跑全量 + typecheck**

Run: `pnpm test src/sidepanel/hooks/useSession && pnpm test src/sidepanel/hooks/useRecording.test.ts && pnpm typecheck`
Expected: useSession ~46 测试全绿（行为回归网）、useRecording 全绿、typecheck 0 错。
若 useSession 测试里有断言 `result.current.port` 或直接 poke `portsRef` 的，按"port 已收编进 swPort"语义改：断言改为验证 `chrome.runtime.connect` 被以 `{name:"chat-stream-..."}` 调用、或 mock swPort。逐个修绿。

- [ ] **Step 8: 提交**

```bash
git add src/sidepanel/hooks/useSession/index.ts src/sidepanel/hooks/useRecording.ts src/sidepanel/hooks/useRecording.test.ts src/sidepanel/App.tsx
git commit -m "fix(sw-connection): port 通道全迁 swPort，修录制 SW 断联无反应 + downloadOutput 潜伏 bug"
```

---

## Task 3: schedules RPC 迁到 swPort.request

**Files:**
- Modify: `src/lib/schedules/panel-actions.ts:61-76`
- Test: `src/lib/schedules/panel-actions.test.ts`（保持绿，必要时微调）

**Interfaces:**
- Consumes: Task 1 的 `swPort.request`。

- [ ] **Step 1: 改 panel-actions.ts 的 send 走 swPort.request**

`src/lib/schedules/panel-actions.ts`：顶部 import `import { swPort } from "@/lib/sw-connection/manager";`，把 `send` 函数体改为：

```ts
async function send(
  action: ScheduleAction["action"],
  payload: ScheduleAction["payload"],
): Promise<ScheduleActionResponse> {
  return swPort.request<ScheduleActionResponse>({
    type: SCHEDULE_ACTION_MESSAGE,
    action,
    payload,
  });
}
```
（`swPort.request` 已内含 try/catch → `{ok:false}` 与 no-response 兜底，原逻辑等价收敛。）

- [ ] **Step 2: 跑 schedules 测试**

Run: `pnpm test src/lib/schedules/panel-actions.test.ts`
Expected: PASS。该测试 stub 全局 `chrome.runtime.sendMessage` 并断言其被以 `{ type, action, payload }` 调用 + 返回值透传——`swPort.request` 底层就是调它、原样透传，断言成立。若该测试自建了局部 chrome stub 而非用全局 mock，确认 `swPort.request` 在测试环境读到的是同一个 stub；不一致则在该测试顶部 `vi.mock("@/lib/sw-connection/manager")` 提供 `request` 直透 `chrome.runtime.sendMessage` 的实现。

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿、0 typecheck 错、build 通过（含 tool-names/tools build-time invariant）。

- [ ] **Step 4: 提交**

```bash
git add src/lib/schedules/panel-actions.ts src/lib/schedules/panel-actions.test.ts
git commit -m "refactor(sw-connection): schedules RPC 迁到 swPort.request"
```

---

## Self-Review

**Spec coverage：**
- §3.1 单例形态 → Task 1（manager.ts 单例 + __resetSwPort + setup reset）。✓
- §3.2 API（connect/send/reconnect/disconnect/disconnectAll/request）→ Task 1 全实现并测。✓
- §3.3 重连安全（subs 与 ports 分离 + fan-out 读最新集合）→ Task 1 实现 + "re-wires SAME subscribers" 测试。✓
- §3.4 panel-mounted 只发一次 → Task 1 openPort + "posts panel-mounted once" 测试。✓
- §3.5 useSession 迁移 → Task 2 Step 5（含 quote-reconnect / unmount / downloadOutput / 删 UseSession.port）。✓
- §3.5 useRecording 迁移 → Task 2 Step 1-4。✓
- §3.5 downloadOutput → Task 2 Step 5.9。✓
- §3.6 schedules RPC → Task 3。✓
- §5 测试（manager / useSession 回归 / useRecording 重写 / 红测试）→ 分布在各 task。✓
- §6 范围外（RPC 不加重连、content-script/offscreen 不动）→ 未触及，符合。✓

**Placeholder scan：** 无 TBD/TODO；每个改动步骤含具体代码或精确行号 + 新形态。Task 2 Step 7 与 Task 3 Step 2 的"逐个修绿/必要时微调"是针对**未知的现存测试断言**的明确处置规则（非占位）。✓

**Type consistency：** `swPort.connect(sessionId, { onMessage, onDisconnect }) => () => void`、`send(sessionId, payload) => boolean`、`request<TRes>(message) => Promise<TRes | {ok:false;error}>` 在 Task 1 定义，Task 2/3 调用签名一致；`PortMessageToPanel`/`PortMessageToWorker` 全程同名。✓
