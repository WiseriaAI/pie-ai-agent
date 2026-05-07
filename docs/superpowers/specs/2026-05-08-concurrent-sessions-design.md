---
date: 2026-05-08
topic: concurrent-sessions
status: brainstormed
related:
  - https://github.com/WiseriaAI/Pie/issues/30  # Issue 主条目（P0）
  - https://github.com/WiseriaAI/Pie/pull/29    # SW 端基础（abort rotation + per-session port + pendingConfirmationsBySession + inFlightSessionIds）
  - docs/ROADMAP.md                             # §12 / 推荐顺序 #7 + §3 / §9 / §10 M3 锚点
  - docs/solutions/2026-05-03-multi-session-invariant-trace.md  # M3 不变量 trace（per-port abortController / verifyPortSession / R7 lock 等）
  - src/sidepanel/hooks/useSession.ts           # 主改造文件（拆为 useSession/{index,runtime-map,port-handlers}.ts）
  - src/background/index.ts                     # SW 端 R13(c) 移除 + keep-alive 智能清
  - src/background/image-cache.ts               # R13 4 路径之一，移除 (c) 调用
---

# 并发会话支持（Concurrent Sessions）

## Problem Frame

PR #29 已让 SW 端真正 per-port / per-task 隔离（独立 `abortController` 旋转 + `pendingConfirmations` + `pendingConfirmationsBySession` + `inFlightSessionIds` + `verifyPortSession`），但 panel 端 `useSession.ts` 的所有 task runtime state 仍是**全局单态**：

- **`portRef: Port | null`** — 任一时刻只持有一个 port
- **`streaming` / `streamingText` / `error` / `toast`** — 单个 React state 槽
- **`accumulatedRef` / `streamFinishedRef` / `messagesRef` / `streamingRef`** — 单个 ref
- **`setActive` / `createAndActivate`** — 切换前 disconnect 旧 port → SW 端 `port.onDisconnect` 触发 `transitionPortInFlightSessionsToPaused` → **正在跑的 task 被强制转 paused**

为兜住"切走 = 杀死 task"的副作用，PR #29 加了临时 streaming guard（`createAndActivate` / `setActive` 读 `streamingRef.current` 拒绝），用户在 task 进行时点 `+` 会被 toast 拒绝。这是**临时方案**，与 issue #30 想解锁的"多 session 真并发跑"目标矛盾。

本 spec 让 panel 端把 per-task runtime state 改成 `Map<sessionId, T>`，外部接口保持单态（active-session 视图派生），从而：

- session A 的 task 在后台继续，session B 同时可以新建并独立发起任务
- 切回 A 时 UI 正确反映 A 当前的 working 状态（streaming / streamingText / agent-step 进度）
- 各 session 的 error / toast / messages 互不串扰
- 自然 close-out roadmap §3 / §9 / §10 中标注的 M3-U6+ 锚点

## Decisions Locked During Brainstorm

| Q | Decision | Rationale |
|---|---|---|
| **并发上限** | 无硬上限 | BYOK 哲学一致；image-cache 30MB/session 自管即兜底；用户开多少路是用户责任 |
| **后台 confirm 通知** | 维持现状（drawer `pendingCount` 红点 + session list 标记），不引入新 surface | issue body 已点出"易错过"，但 toast / Chrome notification / 顶部条的 ROI 都不高；BYOK 扩展不应膨胀通知层 |
| **image-cache R13(c)** | 移除 SW 端 `evictOnSetActive` 调用，per-session LRU 自管；R13(a)/(b)/(d) 保留兜底 | R13(c) 是单 active 优化（"新 port = 旧 active 退场"），并发模式下会破坏后台 vision context |
| **CDP / screenshot quota** | 不改 | CDP 已是 `ownerToken={sessionId,tabId}` + R7 lock；screenshot quota 是浏览器原生节流，agent 已有 retry |
| **`session_index.lastAccessedAt` 抖动** | 接受秒级漂移 | LRU archive 用分钟尺度；秒级抖动不会让"最旧"换序；引入 mutex 是新 bug surface |
| **后台 port 回收** | 永不主动 disconnect；task done 时 SW 清 keep-alive interval；panel unmount 兜底 | done 后 panel 切回需要立即可用、状态无缝；纯 idle port 资源开销恒定，唯一浪费是 keep-alive interval（task 不在跑就该停） |
| **panel state 重构粒度** | 内部 `Map<sessionId, T>`，外部接口保持单态视图（派生） | issue body 写到这个粒度；外部接口零变化 → Chat / App / useRecording 不动；不引入新 state-management lib，不拆双 hook |
| **useSession.ts 模块拆分** | 拆为 `useSession/{index, runtime-map, port-handlers}.ts` | 1182 行已接近"break into smaller units"边界；multi-session 引入的 state map + handler routing 抽出来反而更可读；保守只动 multi-session 涉及面 |

**明确不做**（scope-out）：

- 引入 zustand / Jotai / Recoil 等 state-management lib
- 拆 `useSessionRegistry` + `useActiveSession` 双 hook 形态
- 修改 `UseSession` 外部 interface（Chat / App / useRecording 一行不动）
- 修改 SW 端 wire format（`PortMessageToPanel` / `PortMessageToWorker` schema 已有 sessionId 字段）
- 修改 `SessionMeta` storage schema
- 修改 `setSessionMeta` 的 read-modify-write 模型 / 加 mutex
- 全局 image-cache 上限 / 跨 session LRU 跨 evict
- Chrome 原生通知 / 顶部条 / toast 等新通知 surface
- 并发上限 hint / "其他 session 在跑"指示器
- 重写整个 `useSession.test.ts`（现有单 session 行为测试基本保留，仅必要处改 ref 读法）
- Issue #34（中途插入新指令）/ #38（页内引用） — 必须在 #30 ship 后启动
- roadmap §9 M3 advisory（kt-2/kt-4/kt-5/MAINT-M3-1/MAINT-M3-3/W2/测试 gap） — 不带
- roadmap §10 v1.5.1 follow-ups — 不动

## Section 1 — 架构总览 + 不变量保留

### 1.1 改造覆盖

**Panel 端**：`useSession.ts` 内部所有 per-task runtime state 改为 `Map<sessionId, T>`；外部接口（`UseSession` interface）保持单态视图，由"按 active sessionId 派生"产出。

**SW 端**：仅 2 处微调
- 移除 `evictOnSetActive(portSessionId)` 调用（`background/index.ts:1551`）
- 把 keep-alive `setInterval` 从"port 生命周期常驻"改为"task in-flight 期间生效"

### 1.2 明确保留的不变量

| 不变量 | 来源 | 保留方式 |
|---|---|---|
| `streamingRef` 是 storage onChanged 的同步真相源（Bug-fix-A） | `useSession.ts:230-240` | 升级为 `slotsRef.current.get(sessionId).streaming`；语义不变 |
| storage onChanged listener 仅订阅 active session 的 metaKey | `useSession.ts:620` `useEffect([sessionId])` | 不变；后台 session 的 storage 写不进 active listener，自然安全 |
| archived session 不被 streaming task resurrect | `persistMessages` 内 `current.status === "archived"` early return | 不变；multi-session 下 panel slot 内存态不写 storage，archived 协议不破 |
| port disconnect 时 SW 把 in-flight session 标 paused（R10/R14） | `background/index.ts:1798` `transitionPortInFlightSessionsToPaused` | 不变；panel unmount 时全 port 触发，行为与 M3 一致 |
| `verifyPortSession` + `agent-confirm-response` sessionId 校验 | `background/index.ts:1641, 1671` | 不变；cross-session 防错路由的安全网 |
| CDP `ownerToken={sessionId,tabId}` + R7 cross-session pin lock | M3 invariant trace | 不变；天然 per-session |
| ChatMessage wire format / image untrusted boundary（R15）/ R14 fail-on-image | Phase 5 invariants | 不变 |
| `pendingConfirmationsBySession` / `inFlightSessionIds` per-port closure | `background/index.ts:1580, 1598` | 不变；PR #29 已就绪 |
| `portsBySession` (recording 用) per-session map | `background/index.ts:107` | 不变 |
| ChatMessage string-only wire format / AgentMessage IR SW-only | CLAUDE.md 不变量 | 不变 |

### 1.3 关键决策点对应表

| Issue body 决策点 | 落地 | Spec section |
|---|---|---|
| 后台 confirm 提示 | drawer 红点 + session list 标记（现状） | §3.7 |
| CDP / image-cache / screenshot quota 边界 | R13(c) 移除；其余不改 | §1.2 + §4.1 |
| `session_index` lastAccessedAt 抖动 | 接受 | §3.8 |
| panel unmount disconnect 时机 | unmount 统一 disconnect 全 port；task done 仅清 keep-alive | §3.3 + §4.2 |

## Section 2 — Panel 端模块结构

### 2.1 目标文件树

```
src/sidepanel/hooks/useSession/
  ├── index.ts          — 主 hook，对外仍 export `useSession()` 与 `UseSession` 类型
  ├── runtime-map.ts    — Slot 类型 + Map state/ref helpers + 派生 active 视图
  └── port-handlers.ts  — createPortHandlers(...) 返回 handleMessage / handleDisconnect
```

`Chat.tsx` / `App.tsx` / `useRecording.ts` 的 import path 维持 `@/sidepanel/hooks/useSession`（Vite 路径解析到目录的 `index.ts`），无下游改动。

### 2.2 `runtime-map.ts`

```ts
import type { DisplayMessage } from "@/types";

export type SessionRuntimeSlot = {
  streaming: boolean;
  streamingText: string;
  error: string | null;
  toast: { level: "warn" | "error" | "info"; text: string } | null;
  messages: DisplayMessage[];
  /** mid-stream text accumulator —— 等价于现有 accumulatedRef.current */
  accumulated: string;
  /** 等价于现有 streamFinishedRef.current */
  streamFinished: boolean;
};

export const EMPTY_SLOT: SessionRuntimeSlot = {
  streaming: false,
  streamingText: "",
  error: null,
  toast: null,
  messages: [],
  accumulated: "",
  streamFinished: true,
};

/** 不可变 setter helper —— 压扁所有 setMap(new Map(prev).set(...)) 样板。
 *  patch 可以是 partial 或 (prev) => partial 函数。 */
export function withSlot(
  prev: Map<string, SessionRuntimeSlot>,
  id: string,
  patch:
    | Partial<SessionRuntimeSlot>
    | ((s: SessionRuntimeSlot) => Partial<SessionRuntimeSlot>),
): Map<string, SessionRuntimeSlot> {
  const next = new Map(prev);
  const current = next.get(id) ?? EMPTY_SLOT;
  const resolved = typeof patch === "function" ? patch(current) : patch;
  next.set(id, { ...current, ...resolved });
  return next;
}

/** 派生 active session 视图。activeId 为 null（bootstrap 中）时返回 EMPTY_SLOT。 */
export function deriveActiveView(
  slots: Map<string, SessionRuntimeSlot>,
  activeId: string | null,
): SessionRuntimeSlot {
  if (!activeId) return EMPTY_SLOT;
  return slots.get(activeId) ?? EMPTY_SLOT;
}
```

state 双轨保留——`useState<Map>` 喂 React render，`useRef<Map>` 是同步真相源（Bug-fix-A 等价）：

```ts
const [slots, setSlots] = useState<Map<string, SessionRuntimeSlot>>(new Map());
const slotsRef = useRef<Map<string, SessionRuntimeSlot>>(new Map());

// 必须 SYNCHRONOUSLY 写 slotsRef，再 setSlots（与 streamingRef 同语义）
function patchSlot(id: string, patch: ...) {
  slotsRef.current = withSlot(slotsRef.current, id, patch);
  setSlots(slotsRef.current);
}
```

### 2.3 `port-handlers.ts`

```ts
import type { PortMessageToPanel, DisplayMessage } from "@/types";
import { withSlot, type SessionRuntimeSlot } from "./runtime-map";

export interface CreatePortHandlersDeps {
  slotsRef: React.MutableRefObject<Map<string, SessionRuntimeSlot>>;
  setSlots: React.Dispatch<React.SetStateAction<Map<string, SessionRuntimeSlot>>>;
  persistMessages: (sessionId: string, messages: DisplayMessage[]) => Promise<void>;
}

export interface PortHandlers {
  /** 单实例 listener，绑到所有 port；按 message.sessionId 路由 */
  handleMessage: (msg: PortMessageToPanel) => void;
  /** 闭包绑 sessionId 的 disconnect handler；每次 connectPortFor(id) 时新建 */
  makeDisconnectHandler: (sessionId: string) => () => void;
}

export function createPortHandlers(deps: CreatePortHandlersDeps): PortHandlers;
```

**routing 行为**：现有 `handlePortMessage` 内每个分支（chat-chunk / chat-done / chat-error / agent-step / agent-confirm-request / agent-done-task / session-confirm-request / session-toast）的逻辑一致，但操作目标从 `messagesRef.current` / `accumulatedRef.current` / `streamingRef.current` 等单态 ref 改为 `slotsRef.current.get(message.sessionId)` 对应字段，写回走 `withSlot(prev, message.sessionId, { ... })`。

**关键差异**：
- 删除原 `if (message.sessionId !== sessionIdRef.current) return;` 过滤（`useSession.ts:309`）—— 不再丢非 active session 的消息
- chat-chunk / chat-done / chat-error / agent-step / agent-done-task 的 sessionId 来源是 `message.sessionId`（SW 已发）
- agent-confirm-request 同理：路由到 `message.sessionId` 的 slot；非 active session 的 confirm 卡进入 slot.messages，drawer pendingCount 红点会自然反映（已有 storage onChanged 路径）

### 2.4 `useSession/index.ts` 主 hook

外部接口（`UseSession`）100% 保留。内部改写要点：

```ts
const portsRef = useRef<Map<string, chrome.runtime.Port>>(new Map());
const [slots, setSlots] = useState<Map<string, SessionRuntimeSlot>>(new Map());
const slotsRef = useRef<Map<string, SessionRuntimeSlot>>(new Map());

// 派生 active-session 视图（每次 render）
const active = deriveActiveView(slots, sessionId);

// 输出层用 active.streaming / active.streamingText / active.messages 等
return {
  sessionId, ready, status, pinnedTabs, pinMode,
  messages: active.messages,
  streaming: active.streaming,
  streamingText: active.streamingText,
  error: active.error,
  toast: active.toast,
  // ... mutators (sendMessage, abort, ...)
  port: sessionId ? (portsRef.current.get(sessionId) ?? null) : null,
};
```

**`setActive` 简化**（删原 `useSession.ts:1030-1056` disconnect 旧 port 路径）：

```ts
const setActive = useCallback(async (id: string) => {
  // 删除：if (streaming) return null;  ← #29 临时 guard
  // 删除：portRef.current?.disconnect()
  const meta = await getSessionMeta(id);
  if (!meta) return null;
  if (sessionIdRef.current === id) return id;

  // 现有 legacy-pin migration 保留不变（meta 内容不涉及 multi-session）
  // ...

  await updateLastAccessed(id);

  sessionIdRef.current = id;
  setSessionId(id);
  setStatus(metaForActivate.status);
  setPinnedTabsState(...);
  setPinModeState(...);

  // 加载消息到 slot —— 若 slot 已存在（后台 in-flight session）则保留 streaming 等字段，
  // 仅 messages 同步为 storage 版本 + 用户从未在此次 panel session 见过的更新；
  // 若 slot 不存在（新切到的历史 session）则 init 一个仅 messages 填充的 slot。
  patchSlot(id, (prev) => ({
    messages: prev.streaming ? prev.messages : (metaForActivate.messages ?? []),
  }));

  // 复用已有 port（in-flight session）或建新 port（首次激活该 session）。
  // §3.4 invariant：paused / archived session 切进去不自动建 port —— 用户必须
  // 手动点 "Resume task"（resumeTask 内若 portsRef 没有这条 session 的 port
  // 再临时建）；archived 只读历史，不允许 sendMessage（沿用 R23 auto-create new）。
  if (
    !portsRef.current.has(id) &&
    metaForActivate.status !== "archived" &&
    metaForActivate.status !== "paused"
  ) {
    portsRef.current.set(id, connectPortFor(id));
  }

  return id;
}, [connectPortFor]);
```

**`createAndActivate` 简化**（删 `useSession.ts:1080-1083` streaming guard + `:1098-1099` disconnect 旧 port）：

```ts
const createAndActivate = useCallback(async () => {
  // 删除：if (streamingRef.current) { setToast(...); return null; }  ← #29 临时 guard
  // 删除：portRef.current?.disconnect()
  const meta = await createSession();
  sessionIdRef.current = meta.id;
  setSessionId(meta.id);
  setStatus(meta.status);
  setPinnedTabsState(null);
  setPinModeState("auto");
  patchSlot(meta.id, EMPTY_SLOT);  // brand-new session
  portsRef.current.set(meta.id, connectPortFor(meta.id));
  return meta.id;
}, [connectPortFor]);
```

**`sendMessage` / `abort` / `resumeTask`**：

- `sendMessage` 拿 `portsRef.current.get(sessionIdRef.current)` 操作 active session
- 同步写 `slotsRef`：`patchSlot(activeId, { streaming: true, accumulated: "", streamFinished: false, error: null, messages: updated })`
- 其余逻辑（pin capture / persistMessages / ChatMessage 构造 / port.postMessage）不变
- `abort()` 同理仅操作 `portsRef.current.get(activeId)`
- `resumeTask()` 仅操作 active session 的 port

**unmount cleanup**：

```ts
return () => {
  cancelled = true;
  for (const port of portsRef.current.values()) {
    try { port.disconnect(); } catch {}
  }
  portsRef.current.clear();
};
```

`slotsRef.current` / `setSlots` 不显式 reset —— React unmount 自动 GC。

### 2.5 `connectPortFor` 改造

```ts
const { handleMessage, makeDisconnectHandler } = useMemo(
  () => createPortHandlers({ slotsRef, setSlots, persistMessages }),
  [persistMessages],
);

const connectPortFor = useCallback((id: string) => {
  const port = chrome.runtime.connect({ name: `chat-stream-${id}` });
  port.onMessage.addListener(handleMessage);  // 单实例 listener
  port.onDisconnect.addListener(makeDisconnectHandler(id));  // per-port closure
  port.postMessage({ type: "panel-mounted", sessionId: id });
  return port;
}, [handleMessage, makeDisconnectHandler]);
```

## Section 3 — 关键边界场景

### 3.1 storage onChanged listener 行为

`useEffect(..., [sessionId])` 在 active 切换时重新订阅 active 的 metaKey。后台 session 在跑 task → 写 storage → 不会进 active listener（key 不匹配），自然安全。

当 user 切到 B（B 在跑），listener 重订到 B 的 metaKey；此时 `slotsRef.current.get(B).streaming === true` → 走"streaming 中不 adopt remote messages"分支（即原 `streamingRef.current === true` 分支的 multi-session 等价）。

**改动唯一一行**：原 `if (streamingRef.current) return;`（`useSession.ts:676`）→ `if (slotsRef.current.get(sessionId)?.streaming) return;`。

### 3.2 archived guard 在 multi-session 下的语义

原 `persistMessages` 内 `current.status === "archived"` early return 不变。multi-session 引入新场景：**A 跑到一半被 LRU archive、B 仍 active、A 的 chat-done 还会被推到 panel**。流程：

1. `handleMessage` 收 `chat-done { sessionId: A, ... }`
2. 路由到 `slotsRef.current.get(A)`，写入 messages 末尾的 assistant 文本（**内存态**）
3. 触发 `persistMessages(A, [...])` → 读 storage 见 archived → no-op，**符合 M2-U4 archive 规则**
4. user 切回 A 看到 archived 视图（drawer 已显示 archived 标），slot 内存态作为切回时的"完成态展示"补充；下次 panel 重启时该内存态丢失（archived session 不可 resurrect 协议保持）

### 3.3 panel unmount cleanup 顺序

```ts
return () => {
  cancelled = true;
  // 一次性 disconnect 所有 port —— SW 端 port.onDisconnect 触发
  // transitionPortInFlightSessionsToPaused 把每个 port 在飞的 session 标 paused
  // （和当前单 port 行为一致，只是范围 N 路全部）
  for (const port of portsRef.current.values()) {
    try { port.disconnect(); } catch {}
  }
  portsRef.current.clear();
};
```

panel close = 所有 in-flight session 全部转 paused（用户下次开 panel 看到 R10 resume affordance）。这条 M3 已确立，不变。

### 3.4 切到 paused / archived session 不自动建 port

`setActive(id)` 流程下若 `meta.status === 'paused'`，**不**自动建 port——避免误触发 SW 端 panel-mounted 的 R4 re-emit 后立即 resume。沿用现有逻辑：用户必须手动点 "Resume task" → 那时才 `connectPortFor(id)` + 发 `resume-task` 消息。

archived session 切进去后只读历史，不建 port、不允许 sendMessage（已有 R23 archived → auto-create new）。

**实现要点**：`setActive` 内 `if (!portsRef.current.has(id))` 之前加 status 判断：

```ts
if (!portsRef.current.has(id) && meta.status !== "archived" && meta.status !== "paused") {
  portsRef.current.set(id, connectPortFor(id));
}
```

`resumeTask()` 内首次拿 port 时如果 portsRef 没有 → 临时建一条；现有"sendMessage 拿不到 port 就 return"的防御不变。

### 3.5 Stop 按钮语义（仅 abort active）

`abort()` 仅 abort active session 的 port（`portsRef.current.get(sessionId)` 发 `chat-abort`）。后台 session 不受影响。Chat.tsx 不变，因为 Stop 按钮永远在 active session UI 里。

### 3.6 useRecording 与 port 切换

`useRecording` 当前从 `useSession` 拿 `port: chrome.runtime.Port | null`（active session 的 port）。multi-session 后 `port` getter 仍返回 `portsRef.current.get(sessionId) ?? null`——recording 始终绑 active session 的 port，session-switch 时已有 auto-discard 逻辑（`useRecording.ts:42-56`）。不变。

### 3.7 后台 session 收 confirm 时如何提示（维持现状）

- `agent-confirm-request { sessionId: A }` 路由到 `slotsRef.current.get(A).messages` 末尾（内存态）
- SW 同时写 `session_${A}_agent.pendingConfirm = {...}`（已有 path），触发全局 storage onChanged
- App.tsx 的 `refreshPendingCount` 重扫 → drawer `≡●` 红点更新（已有 path）
- `SessionDrawer` session list 渲染 A 行时显示 pending 标记（已有 path）

**零新代码**——现有 wire path 自然支持。

### 3.8 `session_index.lastAccessedAt` 抖动（接受）

并发 task 同时跑时两路 `updateLastAccessed → setSessionMeta` 可能 last-write-wins 覆盖，A 的时间戳被回退。**实际损失只是 drawer 排序秒级抖动**——下次 step snapshot（5 步内）会自然修复。

`session_index` 仅是 cache，可从 per-session meta key 重建。M2-U4 LRU archive 用 8MB 触发 + 选最旧，分钟尺度的最旧不会被秒级抖动换序。

## Section 4 — SW 端 2 处微调

### 4.1 移除 `R13(c) evictOnSetActive`

`background/index.ts:1551`：

```ts
// 删除这一行：
evictOnSetActive(portSessionId);
```

`evictOnSetActive` 函数本体保留 export（`image-cache.ts:78`）—— 给将来可能的"用户主动清缓存"入口用，但 SW 端不再调用。

**保留的 image-cache 兜底路径**：
- R13(a) `evictSession` —— emitDone 终态（`loop.ts:1035`）
- R13(b) `evictAllOnSWStartup` —— SW 重启清空（`background/index.ts:176`）
- R13(d) `evictByInFlightSet` —— port disconnect 时清这条 port 在飞的 session（`background/index.ts:1801`）
- 每 session 内部 30 MB / last-3-turn LRU（`image-cache.ts:36`）

### 4.2 Task done 时清 keep-alive interval

**当前**（`background/index.ts:1631-1633`）：

```ts
const keepAliveInterval = setInterval(() => {
  chrome.runtime.getPlatformInfo();
}, 25_000);
```

interval 持续到 `port.onDisconnect`（`:1774` 才 clearInterval）。

**改造**：把 interval 句柄改为可重置 + 智能管理：

```ts
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

function ensureKeepAlive() {
  if (keepAliveInterval !== null) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo();
  }, 25_000);
}

function maybeStopKeepAlive() {
  // 仅当本 port 上没有任何 in-flight task 时停
  if (inFlightSessionIds.size === 0 && keepAliveInterval !== null) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}
```

**调用点**：

- `chat-start` / `resume-task` 起手：`ensureKeepAlive()`
- task 终态（`emitDone` 内 chat-done / agent-done-task / chat-error 路径完成后）+ `inFlightSessionIds.delete(sessionId)`：调 `maybeStopKeepAlive()`
- `port.onDisconnect`（`:1774`）：仍调 clearInterval（兜底；正常情况已在 `maybeStopKeepAlive` 清掉）

**实现细节**：`emitDone` 在 `loop.ts` 内部驱动 `chat-done` / `agent-done-task` / `chat-error` 三种终态消息发送；`handleChatStream` / `handleResumeRequest` 是 SW 端的 await 包装层。这两层都已经能观察到终态——选择**包装层 await 后调用**作为统一接入点：

```ts
// background/index.ts —— handleChatStream / handleResumeRequest 末尾
async function handleChatStream(...) {
  // ... 现有 runAgentLoop / handleChatStream 逻辑 ...
  try {
    await /* 现有终态等待路径 */;
  } finally {
    inFlightSessionIds.delete(sessionId);
    maybeStopKeepAlive();
  }
}
```

`finally` 保证异常 / abort 路径（`drainPendingConfirms` 的 aborted 分支）也清理。port disconnect 兜底路径已存在的 `clearInterval` 不变。

**期望状态机**：

| 状态 | keep-alive | 说明 |
|---|---|---|
| 0 个 in-flight task | null | SW 可以 idle out（MV3 默认行为）|
| ≥1 个 in-flight task | active | 防 SW 死 |
| 多路 task 并发跑、其中一路 done | 仍 active | 其他 session 还在跑 |
| 所有 task 跑完、N 个 idle port 都还连着 | null | 下次任一 port 上来 chat-start 重启 |
| panel close 触发所有 port 的 onDisconnect | null | 已存在的兜底 |

### 4.3 不动的 SW 端

明确 scope-out 不动的：

- `pendingConfirmationsBySession` / `inFlightSessionIds` / `verifyPortSession` —— PR #29 已就绪
- `transitionPortInFlightSessionsToPaused` —— 不变（panel close 仍标 paused）
- CDP ownerToken / R7 cross-session pin lock —— 不变
- `portsBySession` (recording 用) —— 不变
- `evictOnSetActive` 函数本体 —— 保留 export，SW 端不再调用
- `abortRotation.ts` per-task 旋转 —— 不变（PR #29 已就绪）
- `drainPendingConfirms` —— 不变

## Section 5 — 测试形态 + Acceptance Gate

### 5.1 现有保留（语义不变）

- `useSession.test.ts` 全部单 session 行为测试 —— 内部从 `streamingRef.current` 改读 `slotsRef.current.get(activeId).streaming`，**断言层不动**
  - streaming / chat-done / error / persist / R10 first-run / archived guard / pin 状态机 / Bug-fix-A 同步真相 / 等
- `image-cache.test.ts` 已有 (a)/(b)/(c)/(d) 4 路径单元测试 —— `(c)` 单测保留（函数本体仍 export），仅在 SW 端集成测试中验证不再被调用

### 5.2 新增

**`src/sidepanel/hooks/useSession.concurrent.test.ts`** — happy-dom + RTL，覆盖：

| # | Case | Acceptance |
|---|---|---|
| 1 | 并发 chat-chunk 路由 | A、B 同时跑，A 的 `chat-chunk` 不影响 B 的 slot；B 的同理 |
| 2 | 后台 done 暂存 + 切回 | A 在跑 → 用户切到新建 B → A 完成（`agent-done-task` 到达）→ 切回 A 看到 summary |
| 3 | 后台 confirm 等待 | A 在 confirm 等待中 → 切到 B → 切回 A confirm 卡仍可点 approve/reject |
| 4 | N 路终态 keep-alive 清除 | mock SW timer，A done + B done 后验证 SW 端 `clearInterval` 被调用一次 |
| 5 | Stop 仅 abort active | A、B 都在跑，active=A，点 Stop → 只有 A 收 `chat-abort`，B 继续 |
| 6 | panel unmount disconnect 全 port | unmount 后 `portsRef.size === 0`，SW 端 `transitionPortInFlightSessionsToPaused` 对每个 port 都触发 |

**`src/background/image-cache.concurrent.test.ts`**（或扩 `image-cache.test.ts`）：

- 两个 session 各自缓存图，新 port connect 时**不**清旧 session 缓存（验证 R13(c) 移除生效）
- task 终态触发 R13(a) 清当条；其余 session cache 不动

### 5.3 Cross-layer regression（per memory `feedback_cross_layer_integration_tests`）

panel↔SW wire shape **不**变（沿用 PR #29 的 `sessionId` 字段 + `verifyPortSession`），但 routing 行为变。

**新增 `src/__tests__/cross-layer/concurrent-task-summary.test.ts`**：

- 模拟 SW 端真实 `runAgentLoop` emit 路径
- A task done 时 SW 端 `agent-done-task { summary, success, stepCount, sessionId: A }` 经 port → panel `handleMessage` 路由 → `slotsRef.current.get(A).messages` 末尾出现 `agent-summary` DisplayMessage
- 切到 A 后 `useSession()` 返回的 `messages` 数组末尾确实是这条 `agent-summary`（派生层正确）
- 此场景**必须真实跑** SW emitDone 路径，不是 mock 消息——这是 Phase 5 教训：高 unit test 数 ≠ 集成正确

### 5.4 Acceptance Gate（spec 必须满足）

| # | Criterion | 验证方式 |
|---|---|---|
| **AC-1** | A 跑 task → 切到新建 B → A 完成 → 切回 A 看到 done summary | concurrent.test.ts case 2 + cross-layer test |
| **AC-2** | A confirm 等待中 → 切 B → 切回 A 仍可 approve | concurrent.test.ts case 3 |
| **AC-3** | A、B 各跑、Stop 只 abort active | concurrent.test.ts case 5 |
| **AC-4** | panel close → 所有 in-flight session 转 paused | concurrent.test.ts case 6 |
| **AC-5** | image-cache 不被新 session 切换误清 | image-cache.concurrent test |
| **AC-6** | 所有 task 终态后 SW keep-alive interval 清除（idle 出 SW） | concurrent.test.ts case 4 |
| **AC-7** | SW `verifyPortSession` + `pendingConfirmationsBySession` 校验仍生效 | sanity smoke（已有测试 + 不引入回归即可） |
| **AC-8** | 现有 `useSession.test.ts` 全绿（无回归） | `pnpm test` |
| **AC-9** | `pnpm build` 干净 | build |

### 5.5 Build-time invariants

`risk.ts` / `tool-names.ts` 的 build-time check 不动。改造过程不引入新 SW 端公共字段，不触发任何 invariant throw。

## Section 6 — 自然 close-out 的 roadmap 锚点

本 spec ship 后，以下 roadmap 章节自然 close：

- **§3 Checkpoint & Resume**："M3-U6+ 锚点"已实现 → 章节标题中的 superseded 注释升级为完成态
- **§9 M3 残余 advisory** 中的 "M3-U6+ panel concurrent" 锚点关闭；其余 advisory（kt-2/kt-4/kt-5/MAINT-M3-1/MAINT-M3-3/W2/测试 gap）作为可选维护项保留
- **§10 v1.5.1 follow-ups** 中"M3-U6+ panel state migration"锚点关闭
- **§12 #30** P0 issue close

`docs/solutions/2026-05-03-multi-session-invariant-trace.md` 的 trace doc 在本 spec 实施完成后追加 §M3-U6 章节，记录 multi-session panel state 落地的 invariant 列表。

## Verification Plan

实施分 4 阶段（具体任务粒度由 writing-plans skill 产出）：

1. **新模块脚手架** —— `runtime-map.ts` + `port-handlers.ts` 接口签名 + 类型 + helper 函数 + 单元测试
2. **useSession/index.ts 改造** —— Map 化 + 派生 view + `setActive`/`createAndActivate` 简化 + #29 临时 guard 移除
3. **SW 端 2 处微调** —— R13(c) 移除 + keep-alive 智能清
4. **测试增强** —— concurrent.test.ts + cross-layer test + image-cache.concurrent test

每阶段单独 commit；阶段间 `pnpm test` + `pnpm build` 全绿后再推进。Acceptance gate AC-1..AC-9 在阶段 4 末统一过。

## Related Specs

- `2026-05-06-provider-config-center-design.md` —— ship 前置 §7（multi-instance）已落地，本 spec 不依赖也不影响该路径
- `2026-05-04-multimodal-image-input.md`（plan 形态） —— Phase 5 R13/R14/R15 不变量在本 spec 严格保留
- `docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md`（M1+M2+M3 已 completed） —— 本 spec 是其"M3-U6+ deferred"的承接

---

**Status**: brainstormed → 待 writing-plans skill 切入实施 plan。
