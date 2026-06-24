# SW 连接服务 — 设计 spec

- 日期：2026-06-24
- 状态：已批准，待写实施 plan
- 触发：Composer 点录制偶发无反应（SW idle-out 导致 port 断联）；要求做通用方案，避免新功能重复踩坑

## 1. 问题与根因

### 1.1 现象
面板空闲一段时间后，第一次点 Composer 的录制按钮偶发无反应。

### 1.2 根因（完整链路，已确认）
1. `src/background/keep-alive.ts` 的保活（每 25s ping `getPlatformInfo`）**只在有 task 在跑时运行**；空闲（无流式任务）超 ~30s → MV3 把 SW idle-out。
2. SW 死后，per-session port 在 panel 侧触发 `onDisconnect`，`useSession` 把该 port 从 `portsRef` 删掉。
3. 此时点录制，`useRecording` 用的是 `useSession` 传进来的裸 `port` 引用 + 三个发送都是 `port.postMessage(...)` 包在静默 `try/catch` 里：
   - `session.port` 已是 `null` → `if (!port) return` 吞掉；或
   - handle 已死 → `postMessage` 抛错被 `catch {}` 吞掉。
   两条路都表现为"点了没反应"。因此**偶发**——必须是面板空闲 30s+ 之后第一次点。

### 1.3 第二半问题：重连后入站订阅失效
port 重连后 handle 换了对象。`useSession` 自己的 chat handler 在 `connectPortFor` 里随每个新 port 重挂（安全）；但任何挂在传入 `port` prop 上的 sibling 订阅（如 `useRecording` 的广播 listener）重连后没人重挂 → 即使发送成功，`recording-started` 等广播也收不到。

### 1.4 这是一类问题，不是单点
per-session port 通道**已有**重连基建（`useSession` 的 `connectPortFor` / `getOrReconnectPort` / `postWithReconnect`），但它私藏在 `useSession`、且只有 `useSession` 自家发送用对了。任何别的功能走这条 port，都得各自重新发明 (a) 发送时重连、(b) 重连后入站订阅重挂——没人发明全。当下的受害者：

| 消费方 | 发送是否走重连 | 状态 |
|---|---|---|
| useSession 自家命令（chat-start/abort/resume/discard/instructions） | ✓ `postWithReconnect` | 正常 |
| useRecording（start/finish/discard） | ✗ 裸 `port.postMessage` + 静默 catch | 本次 bug |
| downloadOutput | ✗ `getOrReconnectPort` 可能返回已死缓存 handle，postMessage 抛错被 catch → resolve error、不重试 | 潜伏同类 bug |

## 2. SW 通信面盘点（panel ↔ SW）

| 通道 | 用途 | 断联问题？ | 本设计处置 |
|---|---|---|---|
| **per-session port** `chat-stream-${id}` | 流式 + 所有命令 | **有**（port 不自动唤醒/重连） | 收编进新服务 |
| **`runtime.sendMessage` RPC** | schedules CRUD（一发一收） | **无**（MV3 自动唤醒 SW，已优雅处理失败） | 同模块、不同方法组（薄 `request`） |
| 带外 `runtime.onMessage`（`quote-needs-reconnect`） | SW 在 port 已死时够 panel 的逃生通道 | — | 保留范式，改调服务的 `reconnect()` |
| content-script → SW（capture / quote） | 不同上下文 | — | 范围外 |
| SW → offscreen | 不同上下文 | — | 范围外 |

## 3. 设计

### 3.1 形态
新增 `src/sidepanel/sw-connection/manager.ts`，导出**模块级单例** `swPort`。一个 panel document 本就只有一套 SW 连接，单例语义正确。`useSession`、`useRecording`、以后的新功能都 import 它做消费方，自己不再调 `chrome.runtime.connect` 或持有 port handle。

- 为何单例而非 hook 参数：`useSession()` 有 ~46 处测试调用，加必填参数会引发大面积测试改动；单例 + `__resetSwPort()`（测试 `beforeEach` 调）做隔离，`useSession()` 签名不变。
- 单例底层仍调 `chrome.runtime.connect`，所以现有 `test/setup.ts` 的 runtime.connect mock 继续生效。

### 3.2 API

```ts
// ── port 通道（流式 + 命令，带透明重连）──
// 订阅 + 保证有活 port + 首连发 panel-mounted；返回 unsubscribe。
// 同一 sessionId 多次 connect 共享同一个 port（合并 handlers，不开第二个 port）。
swPort.connect(
  sessionId: string,
  handlers: { onMessage?: (msg: PortMessageToPanel) => void; onDisconnect?: () => void },
): () => void;

// 透明重连重发：在现有 port 上 postMessage；抛错则丢死 port、重连、重发一次；
// 两次都失败返回 false 由 caller 决定 revert。（= 现 postWithReconnect 提取）
swPort.send(sessionId: string, payload: PortMessageToWorker): boolean;

// 强制丢旧 port 新建（给 quote-needs-reconnect 用）。
swPort.reconnect(sessionId: string): void;

swPort.disconnect(sessionId: string): void;
swPort.disconnectAll(): void;          // panel unmount

// ── RPC 通道（一发一收，不需重连，薄包 runtime.sendMessage）──
// 把 panel-actions.ts 现有 send（try/catch → 失败结构化）提上来泛化。
swPort.request<TReq, TRes>(message: TReq): Promise<TRes | { ok: false; error: string }>;

// ── 测试隔离 ──
__resetSwPort(): void;                 // 断开所有 port、清空 subscriber/disconnect 表
```

内部状态：`Map<sessionId, { port: Port; subscribers: Set<onMessage>; disconnectHandlers: Set<onDisconnect> }>`。

### 3.3 重连安全机制（核心，结构性消除坑）
- 服务对每个 port 只挂**一个** `onMessage` listener，fan-out 给该 sessionId 的所有 `subscribers`。
- 订阅方**永远不持有 port handle**，只交回调。SW idle-out → port 死 → `onDisconnect` 内部清掉该 entry 的 port handle、调用 `disconnectHandlers`（subscriber 集合保留不动）→ 下次 `send`/`connect` 懒重连建新 port → 服务把**同一批 subscribers** 重新挂到新 port 的内部 listener → 入站对订阅方完全透明。
- 由此 stale-handle（本次 bug 的发送侧 + listener 失效的接收侧）在**类型层面**不可能再出现：没有任何外部代码能拿到会过期的 handle。
- 推论：旧的"最小补丁"里设想的 `portEpoch` re-render 重挂 hack **不再需要**；入站靠回调直达，不依赖 React re-render。

### 3.4 `panel-mounted` 握手
服务在每次**新建** port（首连或重连）后内部 post 一次 `{ type:"panel-mounted", sessionId }`（SW 据此从 storage 重建 session 状态、重发 pending session-confirm）。只在 port 新建时发一次，不随 subscriber 数量重复发。

### 3.5 三个 port 消费方迁移（行为保持不变，机械迁移）

**useSession**
- 删除私有 `portsRef` / `connectPortFor` / `getOrReconnectPort` / `postWithReconnect` / `postWithReconnectRef`。
- 每个原 connect 点（mount bootstrap、setActive、createAndActivate）改：
  `swPort.connect(id, { onMessage: portHandlers.handleMessage, onDisconnect: makeFlush(id) })`，其中 `makeFlush(id)` = 现 `portHandlers.makeDisconnectHandler(id)`（断线 flush 残留流式文本 + persist）。port 身份比对、删 entry 的 bookkeeping 由服务内部接管。
- 所有发送（chat-start / chat-abort / resume-task / discard-task / chat-instruction-add / chat-instruction-cancel）改 `swPort.send(id, payload)`，保留各自现有的失败 revert 分支。
- `quote-needs-reconnect` 的 runtime.onMessage listener 保留在 useSession（它需要 `sessionIdRef`），body 改调 `swPort.reconnect(activeId)`。
- unmount cleanup 改 `swPort.disconnectAll()`（仍触发 SW 侧 port.onDisconnect → in-flight session 转 paused 的既有不变量）。
- `UseSession.port` 字段**删除**（外部唯一消费点是 App.tsx 传给 useRecording，迁移后改传 swPort / 直接 import 单例）。

**useRecording**
- 删 `port` prop。
- 三个发送（start/finish/discard）+ 会话切换自动 discard，改 `swPort.send(targetSessionId, {...})`。
- 广播 listener 改 `swPort.connect(sessionId, { onMessage })` 订阅，effect cleanup 调返回的 unsubscribe。handler body 内的类型过滤（只认 `recording-*`）+ sessionId 过滤保留。
- 发送不再需要 `if (!port) return` 守卫（send 自带懒重连）；保留 `if (!sessionId) return`。

**downloadOutput**（RPC 语义、跑在 port 传输上）
- 发送改 `swPort.send(sessionId, { type:"download-output", artifactId })` → 透明重连，顺手修掉潜伏 bug。
- 响应 `file-output-result` 仍走 useSession 的 chat handler 订阅（`port-handlers.ts` 已处理 → `resolveDownload`）。
- 关联层（`registerDownload` / `resolveDownload` + 30s 超时）留在 useSession 不动——只是 correlation，不碰传输。
- 注意：downloadOutput 用 port 的 `send`，**不是** `request`（`request` 专给 runtime.sendMessage RPC）。

### 3.6 RPC 通道迁移
- `swPort.request(message)` = 把 `src/lib/schedules/panel-actions.ts` 现有的 `send`（`chrome.runtime.sendMessage` + try/catch → `{ ok:false, error }`）提取泛化。
- `panel-actions.ts` 的 `createSchedule/updateSchedule/deleteSchedule/toggleSchedule` 改调 `swPort.request({ type: SCHEDULE_ACTION_MESSAGE, action, payload })`。
- **不**给 RPC 通道加任何重连机制——MV3 自动唤醒 SW，它没有断联问题。
- 诚实记录：panel→SW 的 RPC 当下只有 schedules 一个调用方，`request` 略带前瞻性；纳入的理由是统一单一入口 + 干掉 panel-actions 的重复实现 + 作为未来 RPC 功能的落点。

## 4. 错误处理
- `send` 两次（含重连）都失败 → 返回 `false`，由各 caller 决定 revert（useSession 各发送点已有 revert 分支；recording 发送失败静默——与现行为一致，SW 幂等，下次点再试）。
- `request` 失败 → `{ ok:false, error }`，与现 panel-actions 一致。
- `connect` 时 `panel-mounted` post 失败（极端竞态：新 port 立刻死）→ 吞掉不抛，下次 `send` 的 `tryOnce` 会再次失败并走重连（与现 `connectPortFor` 行为一致）。

## 5. 测试
- `manager.test.ts`（新）：
  - `connect` 建 port + 发 panel-mounted；同 sessionId 二次 connect 不开第二 port、不重发 panel-mounted。
  - `send` 在死 port 上抛错 → 丢 port、重连、重发成功；两次失败返回 false。
  - fan-out：多 subscriber 都收到；reconnect 后同批 subscriber 仍收到（重连安全）。
  - `onDisconnect`：port 断 → disconnectHandlers 被调、subscribers 保留。
  - `reconnect`：丢旧建新。
  - `request`：成功透传 response；sendMessage 抛错 → `{ok:false}`。
- `useSession`：行为不变，靠现有 ~46 处测试做回归网（runtime.connect mock 仍生效）。
- `useRecording`：重写为注入 fake `swPort`（send + connect spy），断言 send 调用 + 经订阅 handler fire 广播。
- 红测试（驱动本次修复）：面板空闲 SW idle-out（port 死）后 `startRecording` 仍能重连发出 + 收到 `recording-started` 翻 active。

## 6. 范围外（明确不动）
- `runtime.sendMessage` 的 RPC 通道不加重连（见 3.6）。
- content-script → SW（`recording/capture.ts`、`content/quote/*`）、SW → offscreen（`offscreen-manager.ts`）：不同上下文，不归本服务。

## 7. 风险
- 触及 `useSession` 流式热路径（chat 发送 / 断线 flush / 多会话并发 port）。缓解：纯机械、行为保持不变的迁移；底层仍调 `chrome.runtime.connect` 使现有 mock 与 ~46 处 useSession 测试继续作为回归网；迁移前后 `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿。
- 多会话：useSession 为它管理的每个 session 各调一次 `connect`；服务按 sessionId 隔离 port 与 subscriber。后台任务流入非活动 session 的行为不变。
